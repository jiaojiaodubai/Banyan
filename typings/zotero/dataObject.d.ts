declare namespace Zotero {
  namespace DataObject {
    interface SaveOptions {
      /**
       * Fluent message ID for the undo entry's action label
       * (e.g. `undo-action-edit-creator`); without this the save is captured
       * but discarded at commit.
       */
      undoAction?: string;

      /** Fluent message arguments for the action label (e.g. `{ count: 3 }`). */
      undoActionArgs?: Record<string, unknown>;
    }
  }
}
