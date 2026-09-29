import type {
  RefreshRequestData,
  RefreshResponseData,
} from "../../typings/server";
import type { CitationContext } from "../../typings/style";
import { useL10n } from "../utils/locale";
import {
  buildDocumentCitationPreviewMap,
  getCitedItemsSearchLabel,
  type DocumentCitationPreview,
} from "../utils/citedItemsSearch";
import { renderRichTextToHtml } from "../utils/richTextHtml";

type CitedItemsSearchState = {
  documentId: string;
  libraryID: number | null;
  searchName: string;
  search: Zotero.Search | null;
  itemIDs: number[];
  itemData: Map<number, DocumentCitationPreview>;
};

// `_expandRow` is a private CollectionTree method, so derive its signature from
// the declaration under `typings/` rather than restating it here.
type ExpandRow = _ZoteroTypes.CollectionTree["_expandRow"];

type ZoteroPaneLike = {
  itemsView?: {
    getRow?: (index: number) => { ref?: Zotero.Item } | undefined;
    refreshAndMaintainSelection?: () => Promise<void> | void;
  };
  collectionsView?: _ZoteroTypes.CollectionTree | false;
};

const t = useL10n(["mainWindow.ftl"]);
const CITATION_PREVIEW_PART_CLASS = "banyan-document-citation-part";
// Custom collection-tree row type. It is deliberately not one of Zotero's
// built-in types, so `CollectionTreeRow`'s `id` getter falls through to the
// preset `_id` (see the row construction below) instead of deriving an id from
// a persisted object.
const CITED_ITEMS_ROW_TYPE = "banyanCitedItems";
const CITED_ITEMS_ROW_ID_PREFIX = "banyanCited:";

const citedItemsSearches = new Map<string, CitedItemsSearchState>();
let registeredColumnKey: string | false | null = null;
// Original `_expandRow` of each patched collections view, so cleanup can
// restore it. Keyed by the view instance (one per main window).
const patchedViews = new WeakMap<_ZoteroTypes.CollectionTree, ExpandRow>();

export async function registerCitationColumn(): Promise<void> {
  // Main windows load concurrently, so register synchronously: deferring the
  // assignment past an `await` would let a second window register a duplicate,
  // and `registerColumn()` returns `false` for a duplicate, which would lose
  // the real key that `cleanupCitationColumn()` has to unregister.
  if (registeredColumnKey === null) {
    registeredColumnKey = Zotero.ItemTreeManager.registerColumn({
      dataKey: "citationPreview",
      label: t("item-tree-citation-column"),
      pluginID: addon.data.config.addonID,
      enabledTreeIDs: ["main"],
      flex: 2,
      minWidth: 120,
      zoteroPersist: ["width", "hidden", "sortDirection"],
      dataProvider: (item) => {
        const preview = getPreviewForSelectedCitationColumn(
          Zotero.getMainWindow(),
          item.id,
        );
        return preview ? preview.text : "";
      },
      renderCell: (index, _data, column, _isFirstColumn, doc) => {
        const cell = doc.createElement("span");
        cell.className = `cell ${column.className} banyan-document-citation-cell`;

        const pane = getZoteroPane(doc.defaultView);
        const rowItem = pane?.itemsView?.getRow?.(index)?.ref;
        const preview = rowItem?.id
          ? getPreviewForSelectedCitationColumn(doc.defaultView, rowItem.id)
          : undefined;

        if (preview) {
          cell.innerHTML = preview.htmlParts
            .map(
              (html) =>
                `<span class="${CITATION_PREVIEW_PART_CLASS}">${html}</span>`,
            )
            .join("");
          cell.title = preview.text;
        }
        return cell;
      },
    });
  }

  for (const win of Zotero.getMainWindows()) {
    patchCollectionsView(win);
  }
}

export function cleanupCitationColumn(): void {
  if (registeredColumnKey) {
    Zotero.ItemTreeManager.unregisterColumn(registeredColumnKey);
  }
  registeredColumnKey = null;

  for (const win of Zotero.getMainWindows()) {
    unpatchCollectionsView(win);
  }
  citedItemsSearches.clear();

  void reloadOpenCollectionTrees();
}

export function patchCollectionsView(win: Window): void {
  const view = getZoteroPane(win)?.collectionsView;
  if (!view || patchedViews.has(view)) {
    return;
  }

  const original = view._expandRow.bind(view);
  patchedViews.set(view, original);

  view._expandRow = async (rows, row, forceOpen) => {
    const added = await original(rows, row, forceOpen);
    // Zotero returns `false` for the row types it never expands (publications
    // and feed rows). Keep that result so the callers which accumulate it
    // numerically behave exactly as before.
    if (added === false) {
      return false;
    }
    return added + injectCitedItemsRows(view, rows, row, added);
  };
}

export function unpatchCollectionsView(win: Window): void {
  const view = getZoteroPane(win)?.collectionsView;
  if (!view) {
    return;
  }

  const original = patchedViews.get(view);
  if (original) {
    view._expandRow = original;
    patchedViews.delete(view);
  }
}

export async function updateCitationColumnFromRefresh(
  request: Pick<RefreshRequestData, "documentId" | "contexts">,
  result: RefreshResponseData,
): Promise<void> {
  const documentId = normalizeDocumentId(request.documentId);
  const state = getOrCreateCitedItemsSearchState(documentId);
  state.searchName = getCitedItemsSearchLabel(documentId);
  state.libraryID = getFirstLibraryID(request.contexts) ?? state.libraryID;
  state.itemData = buildDocumentCitationPreviewMap(
    request.contexts,
    result.citations,
    (citation) =>
      renderRichTextToHtml(citation.content, { includeLinks: false }),
  );
  state.itemIDs = Array.from(state.itemData.keys());

  syncSearchForState(state);
  await reloadOpenCollectionTrees();
}

/**
 * Splice one row per matching document after the rows the original `_expandRow`
 * already produced. Only fires for an open library/group row whose libraryID
 * owns cited items, so it mirrors where Zotero injects Unfiled/Retracted.
 */
function injectCitedItemsRows(
  view: _ZoteroTypes.CollectionTree,
  rows: _ZoteroTypes.CollectionTreeRow[],
  row: number,
  added: number,
): number {
  const treeRow = rows[row];
  if (!treeRow.isLibrary?.(true) || treeRow.isOpen === false) {
    return 0;
  }

  const libraryID = treeRow.ref.libraryID;
  const level = (treeRow.level ?? 0) + 1;
  let injected = 0;

  for (const state of citedItemsSearches.values()) {
    if (
      state.libraryID !== libraryID ||
      !state.search ||
      state.itemIDs.length === 0
    ) {
      continue;
    }

    const treeRowRow = new Zotero.CollectionTreeRow(
      view,
      CITED_ITEMS_ROW_TYPE,
      state.search,
      level,
      false,
    );
    treeRowRow._id = `${CITED_ITEMS_ROW_ID_PREFIX}${state.documentId}`;
    rows.splice(row + 1 + added + injected, 0, treeRowRow);
    injected += 1;
  }

  return injected;
}

function getOrCreateCitedItemsSearchState(
  documentId: string,
): CitedItemsSearchState {
  const normalizedId = normalizeDocumentId(documentId);
  let state = citedItemsSearches.get(normalizedId);
  if (state) {
    return state;
  }

  state = {
    documentId: normalizedId,
    libraryID: null,
    searchName: getCitedItemsSearchLabel(normalizedId),
    search: null,
    itemIDs: [],
    itemData: new Map(),
  };
  citedItemsSearches.set(normalizedId, state);
  return state;
}

/**
 * Build/refresh the in-memory search that backs a document's row. The search is
 * never saved: it carries the cited item ids as `itemID is` conditions joined
 * with `any`, so `CollectionTreeRow.getSearchObject()` resolves it natively.
 * Keeping the same search object across refreshes lets already-open item trees
 * pick up new conditions on their next `refreshAndMaintainSelection()`.
 */
function syncSearchForState(state: CitedItemsSearchState): void {
  const libraryID = state.libraryID ?? Zotero.Libraries.userLibraryID;
  if (typeof libraryID !== "number") {
    return;
  }
  state.libraryID = libraryID;

  // `libraryID` is readonly on a search, so recreate it if the document moved
  // to another library.
  if (!state.search || state.search.libraryID !== libraryID) {
    state.search = new Zotero.Search({ libraryID });
  }

  const search = state.search;
  search.name = state.searchName;

  // Remove existing conditions high id first, because removeCondition() shifts
  // the ids of the conditions that follow.
  const conditionIds = Object.keys(search.getConditions())
    .map((id) => Number(id))
    .sort((a, b) => b - a);
  for (const conditionId of conditionIds) {
    search.removeCondition(conditionId);
  }

  search.addCondition("joinMode", "any");
  for (const itemID of state.itemIDs) {
    search.addCondition("itemID", "is", itemID);
  }
}

function getCitedItemsSearchStateByRow(
  row: _ZoteroTypes.CollectionTreeRow | undefined,
): CitedItemsSearchState | null {
  if (!row || row.type !== CITED_ITEMS_ROW_TYPE) {
    return null;
  }

  const rowId = typeof row.id === "string" ? row.id : "";
  if (!rowId.startsWith(CITED_ITEMS_ROW_ID_PREFIX)) {
    return null;
  }

  const documentId = rowId.slice(CITED_ITEMS_ROW_ID_PREFIX.length);
  return citedItemsSearches.get(documentId) ?? null;
}

function getPreviewForSelectedCitationColumn(
  win: Window | null | undefined,
  itemID: number,
): DocumentCitationPreview | undefined {
  const view = getZoteroPane(win)?.collectionsView;
  const row = view ? view.selectedTreeRow : undefined;
  const state = getCitedItemsSearchStateByRow(row);
  return state?.itemData.get(itemID);
}

function getZoteroPane(win: Window | null | undefined): ZoteroPaneLike | null {
  const pane = (win as (Window & { ZoteroPane?: ZoteroPaneLike }) | null)
    ?.ZoteroPane;
  return pane ?? null;
}

function getFirstLibraryID(contexts: CitationContext[]): number | null {
  for (const context of contexts) {
    for (const cite of context.cites) {
      if (typeof cite.item.libraryID === "number") {
        return cite.item.libraryID;
      }
    }
  }
  return null;
}

function normalizeDocumentId(documentId: string): string {
  return documentId.trim();
}

/**
 * Rebuild each open collections tree so new/removed document rows appear, then
 * re-run the items view. Rows wrap the stable per-document search object, so a
 * selected row's items refresh even though the row object itself is recreated.
 */
async function reloadOpenCollectionTrees(): Promise<void> {
  for (const win of Zotero.getMainWindows()) {
    // A window opened after startup may not have been patched yet.
    patchCollectionsView(win);

    const pane = getZoteroPane(win);
    const view = pane?.collectionsView;
    if (view) {
      await view.reload();
    }
    await pane?.itemsView?.refreshAndMaintainSelection?.();
  }
}
