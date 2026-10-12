import { openDialogWindow } from "../utils/window";
import { getLocaleID, useL10n } from "../utils/locale";
import { showSimpleMessage } from "../utils/message";
import { getRegularSelection } from "../utils/selection";
import { normalizeExtraKey, toTitleCaseExtraKey } from "../utils/item";
import type { ItemMenuContribution } from "../../typings/menu";

const t = useL10n(["mainWindow.ftl"]);

type ExtraFieldDialogResult = {
  key: string;
  value: string;
};

type ParsedExtraLine = {
  raw: string;
  normalizedKey: string | null;
  value: string;
};

type ConflictAction = "skip" | "overwrite" | "cancel";

type ConflictDecision = {
  action: ConflictAction;
  applyToRemaining: boolean;
};

export const writeExtraFieldItemMenu: ItemMenuContribution = {
  id: "write-extra-field",
  build() {
    return [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menuitem-write-extra-field"),
        onShowing: (_event, context) => {
          const { canEdit, items } = getRegularSelection();
          context.setVisible(canEdit && items.length > 0);
        },
        onCommand: () => {
          void openWriteExtraFieldDialog();
        },
      },
    ];
  },
};

async function openWriteExtraFieldDialog(): Promise<void> {
  const pane = Zotero.getActiveZoteroPane();
  if (!pane) {
    return;
  }
  const selectedItems = pane
    .getSelectedItems()
    .filter((item) => item.isRegularItem());

  if (selectedItems.length === 0) {
    return;
  }

  return new Promise((resolve) => {
    const io = {
      result: null as ExtraFieldDialogResult | null,
      deferred: {
        promise: Promise.resolve(),
        resolve: async () => {
          if (io.result) {
            try {
              await batchWriteExtraField(selectedItems, io.result);
            } catch (e) {
              ztoolkit.logError(e);
              showSimpleMessage(
                t("extra-field-write-failed", {
                  args: {
                    message: e instanceof Error ? e.message : String(e),
                  },
                }),
              );
            }
          }
          resolve();
        },
      },
    };

    openDialogWindow(
      `chrome://${addon.data.config.addonRef}/content/extraFieldDialog.xhtml`,
      "modal,resizable=yes",
      io,
    );
  });
}

async function batchWriteExtraField(
  items: Zotero.Item[],
  payload: ExtraFieldDialogResult,
): Promise<void> {
  // Write keys in Zotero's preferred title-case form (e.g. "Type",
  // "Citation Key"); matching still uses the lowercase kebab normalization.
  const writeKey = toTitleCaseExtraKey(payload.key);
  const value = payload.value;
  const normalizedKey = normalizeExtraKey(writeKey);
  if (!normalizedKey) {
    showSimpleMessage(t("extra-field-error-invalid-key"));
    return;
  }

  let autoAction: Exclude<ConflictAction, "cancel"> | null = null;
  let updatedCount = 0;
  let skippedCount = 0;
  let aborted = false;

  for (const item of items) {
    const originalExtra = String(item.getField("extra") || "");
    const analysis = analyzeExtraField(originalExtra, normalizedKey);

    if (analysis.values.length > 0) {
      let action: ConflictAction;
      if (autoAction) {
        action = autoAction;
      } else {
        const decision = promptExtraConflict(item, writeKey, analysis.values);
        if (decision.action === "cancel") {
          aborted = true;
          break;
        }
        if (decision.applyToRemaining) {
          autoAction = decision.action;
        }
        action = decision.action;
      }

      if (action === "skip") {
        skippedCount++;
        continue;
      }
    }

    const nextExtra = mergeExtraField(
      originalExtra,
      writeKey,
      normalizedKey,
      value,
    );

    if (nextExtra === originalExtra) {
      skippedCount++;
      continue;
    }

    item.setField("extra", nextExtra);
    await item.saveTx();
    updatedCount++;
  }

  showSimpleMessage(
    t("extra-field-write-summary", {
      args: {
        updated: updatedCount,
        skipped: skippedCount,
        aborted: aborted ? 1 : 0,
      },
    }),
  );
}

function analyzeExtraField(
  extraText: string,
  normalizedKey: string,
): {
  values: string[];
} {
  const parsed = parseExtraLines(extraText);
  const values = parsed
    .filter((line) => line.normalizedKey === normalizedKey)
    .map((line) => line.value);
  return { values };
}

function parseExtraLines(extraText: string): ParsedExtraLine[] {
  return extraText.split(/\r?\n/).map((raw) => {
    const index = raw.indexOf(":");
    if (index <= 0) {
      return {
        raw,
        normalizedKey: null,
        value: "",
      };
    }

    const key = raw.slice(0, index).trim();
    return {
      raw,
      normalizedKey: normalizeExtraKey(key),
      value: raw.slice(index + 1).trim(),
    };
  });
}

function mergeExtraField(
  extraText: string,
  writeKey: string,
  normalizedKey: string,
  value: string,
): string {
  const newline = extraText.includes("\r\n") ? "\r\n" : "\n";
  const lines = extraText ? extraText.split(/\r?\n/) : [];
  const parsed = parseExtraLines(extraText);
  const newLine = `${writeKey}: ${value}`;

  const firstMatchIndex = parsed.findIndex(
    (line) => line.normalizedKey === normalizedKey,
  );

  if (firstMatchIndex === -1) {
    if (lines.length === 0) {
      return newLine;
    }
    return [...lines, newLine].join(newline);
  }

  let replaced = false;
  const out: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].normalizedKey !== normalizedKey) {
      out.push(parsed[i].raw);
      continue;
    }

    if (!replaced) {
      out.push(newLine);
      replaced = true;
    }
  }
  return out.join(newline);
}

function promptExtraConflict(
  item: Zotero.Item,
  writeKey: string,
  existingValues: string[],
): ConflictDecision {
  const checkState = { value: false };
  const itemLabel =
    String(item.getField("title") || "").trim() ||
    String(item.getDisplayTitle?.() || "").trim() ||
    item.key;
  const existingText = existingValues.join("; ");

  const selected = Zotero.Prompt.confirm({
    window: Zotero.getMainWindow(),
    title: t("extra-field-conflict-title"),
    text: t("extra-field-conflict-message", {
      args: {
        item: itemLabel,
        key: writeKey,
        existing: existingText,
      },
    }),
    button0: t("extra-field-conflict-skip"),
    button1: t("extra-field-conflict-overwrite"),
    button2: Zotero.Prompt.BUTTON_TITLE_CANCEL,
    checkLabel: t("extra-field-conflict-apply-to-remaining"),
    checkbox: checkState,
  });

  if (selected === 0) {
    return { action: "skip", applyToRemaining: checkState.value };
  }
  if (selected === 1) {
    return { action: "overwrite", applyToRemaining: checkState.value };
  }
  return { action: "cancel", applyToRemaining: false };
}
