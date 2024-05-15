/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import { getFormattedDate } from "@notesnook/common";
import { isEncryptedContent } from "@notesnook/core/dist/collections/content";
import { NoteContent } from "@notesnook/core/dist/collections/session-content";
import { EVENTS } from "@notesnook/core/dist/common";
import {
  ContentItem,
  ContentType,
  DeletedItem,
  ItemReference,
  Note,
  TrashItem,
  UnencryptedContentItem,
  isDeleted,
  isTrashItem
} from "@notesnook/core/dist/types";
import { EditorEvents } from "@notesnook/editor-mobile/src/utils/editor-events";
import { NativeEvents } from "@notesnook/editor-mobile/src/utils/native-events";
import { useThemeEngineStore } from "@notesnook/theme";
import { Mutex } from "async-mutex";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WebView from "react-native-webview";
import { DatabaseLogger, db } from "../../../common/database";
import useGlobalSafeAreaInsets from "../../../hooks/use-global-safe-area-insets";
import { DDS } from "../../../services/device-detection";
import {
  ToastManager,
  eSendEvent,
  eSubscribeEvent,
  eUnSubscribeEvent
} from "../../../services/event-manager";
import Navigation from "../../../services/navigation";
import Notifications from "../../../services/notifications";
import SettingsService from "../../../services/settings";
import { useSettingStore } from "../../../stores/use-setting-store";
import { useTagStore } from "../../../stores/use-tag-store";
import {
  eEditorReset,
  eEditorTabFocused,
  eOnLoadNote,
  eShowMergeDialog,
  eUpdateNoteInEditor
} from "../../../utils/events";
import { tabBarRef } from "../../../utils/global-refs";
import { sleep } from "../../../utils/time";
import { unlockVault } from "../../../utils/unlock-vault";
import { onNoteCreated } from "../../notes/common";
import Commands from "./commands";
import { SessionHistory } from "./session-history";
import { EditorState, SavePayload } from "./types";
import { syncTabs, useTabStore } from "./use-tab-store";
import {
  clearAppState,
  defaultState,
  getAppState,
  isContentInvalid,
  isEditorLoaded,
  post
} from "./utils";

const loadNoteMutex = new Mutex();

type NoteWithContent = Note & {
  content?: NoteContent<false>;
};

export const useEditor = (
  editorId = "",
  readonly?: boolean,
  onChange?: (html: string) => void
) => {
  const theme = useThemeEngineStore((state) => state.theme);
  const [loading, setLoading] = useState(false);
  const sessionIdRef = useRef("notesnook-editor");
  const editorRef = useRef<WebView>(null);

  const currentNotes = useRef<
    Record<
      string,
      | (Note & {
          content?: NoteContent<false> & {
            isPreview?: boolean;
          };
        })
      | null
      | undefined
    >
  >({});

  const currentContents = useRef<
    Record<string, Partial<UnencryptedContentItem> | null>
  >({});

  const timers = useRef<{ [name: string]: NodeJS.Timeout }>({});
  const commands = useMemo(() => new Commands(editorRef), [editorRef]);
  const editorSessionHistory = useMemo(() => new SessionHistory(), []);
  const state = useRef<Partial<EditorState>>(defaultState);
  const tags = useTagStore((state) => state.items);
  const insets = useGlobalSafeAreaInsets();
  const isDefaultEditor = editorId === "";
  const saveCount = useRef(0);
  const lastContentChangeTime = useRef<Record<string, number>>({});
  const lock = useRef(false);
  const currentLoadingNoteId = useRef<string>();
  const loadingState = useRef<string>();
  const lastTabFocused = useRef(0);
  const blockIdRef = useRef<string>();
  const postMessage = useCallback(
    async <T>(type: string, data: T, tabId?: number, waitFor = 300) =>
      await post(
        editorRef,
        sessionIdRef.current,
        typeof tabId !== "number" ? useTabStore.getState().currentTab : tabId,
        type,
        data,
        waitFor
      ),
    [sessionIdRef]
  );

  useEffect(() => {
    commands.setInsets(
      isDefaultEditor ? insets : { top: 0, left: 0, right: 0, bottom: 0 }
    );
  }, [commands, insets, isDefaultEditor]);

  useEffect(() => {
    postMessage(NativeEvents.theme, theme);
  }, [theme, postMessage]);

  useEffect(() => {
    for (const id in currentNotes.current) {
      commands.setTags(currentNotes.current[id]);
    }
  }, [commands, tags]);

  useEffect(() => {
    const event = eSubscribeEvent(eEditorTabFocused, (tabId) => {
      console.log("Editot tab focus changed", lastTabFocused.current, tabId);
      if (lastTabFocused.current !== tabId) lock.current = false;
      lastTabFocused.current = tabId as number;
    });
    return () => {
      event?.unsubscribe();
    };
  });

  const overlay = useCallback(
    (show: boolean, data = { type: "new" }) => {
      eSendEvent(
        "loadingNote" + editorId,
        show ? data || currentNotes.current : false
      );
    },
    [editorId]
  );

  useEffect(() => {
    if (loading) {
      overlay(true);
      state.current.ready = false;
      setLoading(false);
    }
  }, [loading, overlay]);

  const withTimer = useCallback(
    (id: string, fn: () => void, duration: number) => {
      clearTimeout(timers.current[id]);
      timers.current[id] = setTimeout(fn, duration);
    },
    []
  );

  const reset = useCallback(
    async (tabId: number, resetState = true, resetContent = true) => {
      console.log("Resetting tab:", tabId);
      const noteId = useTabStore.getState().getNoteIdForTab(tabId);
      if (noteId) {
        currentNotes.current?.id && db.fs().cancel(noteId);
        currentNotes.current[noteId] = null;
        currentContents.current[noteId] = null;
        editorSessionHistory.clearSession(noteId);
        lastContentChangeTime.current[noteId] = 0;
        clearTimeout(timers.current["loading-images" + noteId]);
      }

      saveCount.current = 0;
      loadingState.current = undefined;
      currentLoadingNoteId.current = undefined;
      lock.current = false;
      resetContent && postMessage(NativeEvents.title, "", tabId);

      resetContent && (await commands.clearContent(tabId));
      resetContent && (await commands.clearTags(tabId));
      useTabStore.getState().updateTab(tabId, {
        noteId: undefined,
        locked: false,
        noteLocked: false,
        readonly: false
      });
    },
    [commands, editorSessionHistory, postMessage]
  );

  const saveNote = useCallback(
    async ({
      title,
      id,
      data,
      type,
      ignoreEdit,
      sessionHistoryId: currentSessionHistoryId,
      tabId,
      pendingChanges
    }: SavePayload) => {
      if (currentNotes.current[id as string]?.readonly || readonly) return;
      try {
        if (id && !(await db.notes?.note(id))) {
          await reset(tabId);
          return;
        }
        let note = id ? await db.notes?.note(id) : undefined;
        const locked = note && (await db.vaults.itemExists(note));

        if (note?.conflicted) {
          eSendEvent(eShowMergeDialog, note);
          return;
        }

        if (isContentInvalid(data) && id) {
          // Create a new history session if recieved empty or invalid content
          // To ensure that history is preserved for correct content.
          currentSessionHistoryId = editorSessionHistory.newSession(id);
        }

        const noteData: Partial<Note> & {
          sessionId?: string;
          content?: NoteContent<false>;
        } = {
          id,
          sessionId: `${currentSessionHistoryId}`
        };

        noteData.title = title;

        if (ignoreEdit) {
          DatabaseLogger.log("Ignoring edits...");
          noteData.dateEdited = note?.dateEdited;
        }

        if (data) {
          noteData.content = {
            data: data,
            type: type as ContentType
          };
        }

        let saved = false;
        setTimeout(() => {
          if (saved) return;
          commands.setStatus(
            getFormattedDate(note ? note.dateEdited : Date.now(), "date-time"),
            "Saving",
            tabId
          );
        }, 50);

        const saveTimer = setTimeout(() => {
          DatabaseLogger.log(`Note save timeout: ${id}...`);
          ToastManager.error(
            new Error(
              "Copy your changes and restart the app to avoid data loss. If the issue persists, please report to us at support@streetwriters.co."
            ),
            "Saving note is taking too long",
            "global",
            15000
          );
        }, 30 * 1000);

        if (!locked) {
          DatabaseLogger.log(`Saving note: ${id}...`);
          console.log("SAVE DATA", noteData);
          id = await db.notes?.add({ ...noteData });
          saved = true;
          DatabaseLogger.log(`Note saved: ${id}...`);

          clearTimeout(saveTimer);

          if (!note && id) {
            editorSessionHistory.newSession(id);
            if (id) {
              currentNotes.current[id] = await db.notes?.note(id);
            }

            useTabStore.getState().updateTab(tabId, {
              noteId: id
            });

            const defaultNotebook = db.settings.getDefaultNotebook();
            if (!state.current.onNoteCreated && defaultNotebook) {
              onNoteCreated(id, {
                type: "notebook",
                id: defaultNotebook
              });
            } else {
              state.current?.onNoteCreated && state.current.onNoteCreated(id);
            }

            if (!noteData.title) {
              postMessage(
                NativeEvents.title,
                currentNotes.current[id]?.title,
                tabId
              );
            }
          }

          if (Notifications.isNotePinned(id as string)) {
            Notifications.pinNote(id as string);
          }
        } else {
          if (!db.vault.unlocked) {
            if (pendingChanges) await sleep(3000);
            const unlocked = await unlockVault({
              title: "Unlock vault to save note",
              paragraph: `This note is locked, unlock to save ${
                pendingChanges ? "some pending" : ""
              } changes`,
              context: "global"
            });
            if (!unlocked)
              throw new Error("Could not save note, vault is locked");
          }
          noteData.contentId = note?.contentId;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await db.vault?.save(noteData as any);
          clearTimeout(saveTimer);
        }

        if (id) {
          useTabStore.getState().forEachNoteTab(id, (tab) => {
            if (tab.id !== tabId) {
              useTabStore.getState().updateTab(tab.id, {
                needsRefresh: true
              });
            }
          });
        }

        if (id && useTabStore.getState().getTab(tabId)?.noteId === id) {
          note = (await db.notes?.note(id)) as Note;
          await commands.setStatus(
            getFormattedDate(note.dateEdited, "date-time"),
            "Saved",
            tabId
          );

          lastContentChangeTime.current[id] = note.dateEdited;

          if (
            saveCount.current < 2 ||
            currentNotes.current[id]?.title !== note.title ||
            currentNotes.current[id]?.headline?.slice(0, 200) !==
              note.headline?.slice(0, 200)
          ) {
            Navigation.queueRoutesForUpdate();
          }
        }

        if (
          id &&
          id === useTabStore.getState().getCurrentNoteId() &&
          pendingChanges
        ) {
          postMessage(NativeEvents.title, title || note?.title, tabId);
          postMessage(NativeEvents.html, data, tabId);
          currentNotes.current[id] = note;
        }

        saveCount.current++;
        return id;
      } catch (e) {
        console.error(e);
        DatabaseLogger.error(e as Error);
      }
    },
    [commands, editorSessionHistory, postMessage, readonly, reset]
  );

  const loadContent = useCallback(
    async (
      note: Note & {
        content?: NoteContent<false>;
      }
    ) => {
      currentNotes.current[note.id] = note;
      const locked = note && (await db.vaults.itemExists(note));
      if ((locked || note.content) && note.content?.data) {
        currentContents.current[note.id] = {
          data: note.content?.data,
          type: note.content?.type || "tiptap",
          noteId: note.id
        };
      } else if (note.contentId) {
        const rawContent = await db.content?.get(note.contentId);
        if (rawContent && isEncryptedContent(rawContent)) {
          const unlocked = await unlockVault({
            title: "Unlock vault to load note",
            paragraph: "This note is locked, unlock to load content",
            context: "global"
          });
          if (!unlocked) return;
          const decryptedContent = await db.vault?.decryptContent(rawContent);
          if (decryptedContent) {
            currentContents.current[note.id] = {
              data: decryptedContent.data,
              type: decryptedContent.type,
              noteId: note.id
            };
          }
        } else if (rawContent && !isDeleted(rawContent) && !rawContent.locked) {
          currentContents.current[note.id] = {
            data: rawContent.data,
            type: rawContent.type
          };
        }
      }
    },
    []
  );

  const loadNote = useCallback(
    (event: {
      item?: Note;
      forced?: boolean;
      newNote?: boolean;
      tabId?: number;
      blockId?: string;
      newTab?: boolean;
      refresh?: boolean;
    }) => {
      loadNoteMutex.runExclusive(async () => {
        if (!event) return;
        if (event.blockId) {
          blockIdRef.current = event.blockId;
        }
        state.current.currentlyEditing = true;

        if (
          !state.current.ready &&
          (await isEditorLoaded(
            editorRef,
            sessionIdRef.current,
            useTabStore.getState().currentTab
          ))
        ) {
          state.current.ready = true;
        }

        if (event.newNote && !currentLoadingNoteId.current) {
          const tabId = useTabStore.getState().currentTab;
          await reset(tabId, true, true);
          setTimeout(() => {
            if (state.current?.ready && !state.current.movedAway)
              commands.focus(tabId);
          });
        } else {
          if (!event.item) {
            overlay(false);
            return;
          }

          const item = event.item;
          currentLoadingNoteId.current = item.id;

          const currentTab = useTabStore
            .getState()
            .getTab(useTabStore.getState().currentTab);
          if (currentTab?.previewTab && item.id !== currentTab.noteId) {
            await commands.setLoading(true, useTabStore.getState().currentTab);
          }
          const isLockedNote = await db.vaults.itemExists(
            event.item as ItemReference
          );
          const tabLocked =
            isLockedNote && !(event.item as NoteWithContent).content;

          let tabId = event.tabId;
          if (tabId === undefined) tabId = useTabStore.getState().currentTab;

          let isOpened = false;

          useTabStore.getState().forEachNoteTab(item.id, (tab) => {
            if (tab.id === useTabStore.getState().currentTab) {
              isOpened = true;
            }
          });

          if (!isOpened && !event.refresh) {
            await commands.setLoading(true, tabId);
          }

          if (event.newTab) {
            tabId = useTabStore.getState().newTab({
              noteId: event.item.id,
              locked: tabLocked,
              noteLocked: isLockedNote,
              readonly: event.item.readonly || readonly
            });
          } else {
            useTabStore.getState().updateTab(tabId, {
              readonly: event.item.readonly || readonly,
              ...(isOpened
                ? {
                    noteId: event.item.id
                  }
                : {
                    locked: tabLocked,
                    noteLocked: isLockedNote,
                    noteId: event.item.id
                  })
            });
          }

          useTabStore.getState().focusTab(tabId);

          if (lastTabFocused.current !== tabId) {
            useTabStore.getState().focusTab(tabId);
          }

          setTimeout(() => {
            if (blockIdRef.current) {
              commands.scrollIntoViewById(blockIdRef.current);
              blockIdRef.current = undefined;
            }
          }, 150);

          if (lastTabFocused.current !== tabId) {
            // if ((await waitForEvent(eEditorTabFocused, 1000)) !== tabId) {
            //   console.log("tab id did not match after focus in 1000ms");
            //   return;
            // }
            currentLoadingNoteId.current = item.id;
            console.log("Waiting for tab to focus");
            return;
          }

          state.current.movedAway = false;
          state.current.currentlyEditing = true;

          if (!tabLocked) {
            await loadContent(item);
          }

          if (
            currentNotes.current[item.id] &&
            loadingState.current &&
            currentContents.current[item.id]?.data &&
            loadingState.current === currentContents.current[item.id]?.data
          ) {
            // If note is already loading, return.
            console.log("Note is already loading...");
            return;
          }

          if (!state.current.ready) {
            currentNotes.current[item.id] = item;
            currentLoadingNoteId.current = event.item?.id;
            return;
          }

          lastContentChangeTime.current[item.id] = item.dateEdited;
          currentNotes.current[item.id] = item;

          if (!currentNotes.current[item.id]) return;

          editorSessionHistory.newSession(item.id);

          await commands.setStatus(
            getFormattedDate(item.dateEdited, "date-time"),
            "Saved",
            tabId
          );
          await postMessage(NativeEvents.title, item.title, tabId);
          overlay(false);
          loadingState.current = currentContents.current[item.id]?.data;

          await postMessage(
            event?.refresh ? NativeEvents.updatehtml : NativeEvents.html,
            currentContents.current[item.id]?.data || "",
            tabId,
            10000
          );

          setTimeout(() => {
            if (blockIdRef.current) {
              commands.scrollIntoViewById(blockIdRef.current);
              blockIdRef.current = undefined;
            }
          }, 300);

          loadingState.current = undefined;
          await commands.setTags(item);
          commands.setSettings();
          setTimeout(() => {
            if (currentLoadingNoteId.current === event.item?.id) {
              currentLoadingNoteId.current = undefined;
            }
          }, 300);
        }
        postMessage(NativeEvents.theme, theme);
      });
    },
    [
      commands,
      editorSessionHistory,
      loadContent,
      overlay,
      postMessage,
      readonly,
      reset,
      theme
    ]
  );

  const onSyncComplete = useCallback(
    async (
      data: Note | ContentItem | TrashItem | DeletedItem,
      isLocal?: boolean
    ) => {
      try {
        await (async () => {
          if (SettingsService.get().disableRealtimeSync && !isLocal) return;
          if (!data) return;

          if (isDeleted(data) || isTrashItem(data)) {
            useTabStore.getState().forEachNoteTab(data.id, (tab) => {
              commands.clearContent(tab.id);
              useTabStore.getState().removeTab(tab.id);
            });
            return;
          }

          const noteId =
            (data as ContentItem).type === "tiptap"
              ? (data as ContentItem).noteId
              : data.id;

          if (!useTabStore.getState().hasTabForNote(noteId)) return;

          const note =
            data.type === "note" ? data : await db.notes?.note(noteId);

          lock.current = true;

          // Handle this case where note was locked on another device and synced.
          const locked = await db.vaults.itemExists(
            currentNotes.current[noteId] as ItemReference
          );

          if (note) {
            useTabStore.getState().forEachNoteTab(note.id, (tab) => {
              const tabId = tab.id;
              if (!locked && tab?.noteLocked) {
                // Note lock removed.
                if (tab.locked) {
                  if (useTabStore.getState().currentTab === tabId) {
                    eSendEvent(eOnLoadNote, {
                      item: note,
                      forced: true
                    });
                  } else {
                    useTabStore.getState().updateTab(tabId, {
                      locked: false,
                      noteLocked: false
                    });
                    commands.setLoading(true, tabId);
                  }
                }
              } else if (!tab?.noteLocked && locked) {
                // Note lock added.
                useTabStore.getState().updateTab(tabId, {
                  locked: true,
                  noteLocked: true
                });
                if (useTabStore.getState().currentTab !== tabId) {
                  commands.clearContent(tabId);
                  commands.setLoading(true, tabId);
                }
              }

              if (currentNotes.current[noteId]?.title !== note.title) {
                postMessage(NativeEvents.title, note.title, tabId);
              }
              commands.setTags(note);
              if (
                currentNotes.current[noteId]?.dateEdited !== note.dateEdited
              ) {
                commands.setStatus(
                  getFormattedDate(note.dateEdited, "date-time"),
                  "Saved",
                  tabId as number
                );
              }

              console.log("readonly state changed...", note.readonly);

              useTabStore.getState().updateTab(tabId, {
                readonly: note.readonly
              });
            });
          }

          if (data.type === "tiptap" && note && !isLocal) {
            if (lastContentChangeTime.current[noteId] >= data.dateEdited) {
              return;
            }

            if (locked && isEncryptedContent(data)) {
              const decryptedContent = await db.vault?.decryptContent(data);
              if (!decryptedContent) {
                useTabStore.getState().forEachNoteTab(note.id, (tab) => {
                  const tabId = tab.id;

                  useTabStore.getState().updateTab(tabId, {
                    locked: true,
                    noteLocked: true
                  });
                  if (useTabStore.getState().currentTab !== tabId) {
                    commands.clearContent(tabId);
                    commands.setLoading(true, tabId);
                  }
                });
              } else {
                useTabStore.getState().forEachNoteTab(note.id, (tab) => {
                  const tabId = tab.id;
                  if (tab.id !== useTabStore.getState().currentTab) {
                    useTabStore.getState().updateTab(tabId, {
                      needsRefresh: true
                    });
                  } else {
                    postMessage(
                      NativeEvents.updatehtml,
                      decryptedContent.data,
                      tabId
                    );
                  }
                });

                currentContents.current[note.id] = decryptedContent;
              }
            } else {
              const _nextContent = data.data;
              if (_nextContent === currentContents.current?.data) {
                return;
              }
              lastContentChangeTime.current[note.id] = note.dateEdited;

              useTabStore.getState().forEachNoteTab(note.id, (tab) => {
                const tabId = tab.id;
                if (tab.id !== useTabStore.getState().currentTab) {
                  useTabStore.getState().updateTab(tabId, {
                    needsRefresh: true
                  });
                } else {
                  postMessage(NativeEvents.updatehtml, _nextContent, tabId);
                }
              });

              if (!isEncryptedContent(data)) {
                currentContents.current[note.id] =
                  data as UnencryptedContentItem;
              }
            }
          }
        })();
      } catch (e) {
        DatabaseLogger.error(e as Error, "Error when applying sync changes");
      } finally {
        lock.current = false;
      }
    },
    [postMessage, commands]
  );

  useEffect(() => {
    const subs = [
      db.eventManager.subscribe(EVENTS.syncItemMerged, onSyncComplete),
      eSubscribeEvent(eOnLoadNote + editorId, loadNote),
      eSubscribeEvent(eUpdateNoteInEditor, onSyncComplete)
    ];
    return () => {
      subs.forEach((sub) => sub?.unsubscribe());
    };
  }, [editorId, loadNote, onSyncComplete]);

  const saveContent = useCallback(
    ({
      title,
      content,
      type,
      ignoreEdit,
      noteId,
      tabId,
      pendingChanges
    }: {
      noteId?: string;
      title?: string;
      content?: string;
      type: string;
      ignoreEdit: boolean;
      tabId: number;
      pendingChanges?: boolean;
    }) => {
      DatabaseLogger.log(
        `saveContent... title: ${!!title}, content: ${!!content}, noteId: ${noteId}`
      );
      if (
        lock.current ||
        (currentLoadingNoteId.current &&
          currentLoadingNoteId.current === noteId)
      ) {
        DatabaseLogger.log(`Skipped saving content:

          lock.current: ${lock.current}
          currentLoadingNoteId.current: ${currentLoadingNoteId.current}
        `);
        if (lock.current) {
          setTimeout(() => {
            if (lock.current) {
              DatabaseLogger.warn("Editor force removed lock after 5 seconds");
              lock.current = false;
            }
          }, 5000);
        }
        return;
      }

      if (noteId) {
        lastContentChangeTime.current[noteId] = Date.now();
      }

      if (type === EditorEvents.content && noteId) {
        currentContents.current[noteId as string] = {
          data: content,
          type: "tiptap",
          noteId: noteId as string
        };
      }

      const params: SavePayload = {
        title,
        data: content,
        type: "tiptap",
        id: noteId,
        ignoreEdit,
        sessionHistoryId: noteId ? editorSessionHistory.get(noteId) : undefined,
        tabId: tabId,
        pendingChanges
      };
      withTimer(
        noteId || "newnote",
        () => {
          if (!params.id) {
            params.id = useTabStore.getState().getNoteIdForTab(tabId);
          }
          if (onChange && params.data) {
            onChange(params.data);
            return;
          }
          if (useSettingStore.getState().isAppLoading) {
            const sub = useSettingStore.subscribe((state) => {
              if (!state.isAppLoading) {
                saveNote(params);
                sub();
              }
            });
          } else {
            saveNote(params);
          }
        },
        ignoreEdit ? 0 : 150
      );
    },
    [editorSessionHistory, withTimer, onChange, saveNote]
  );

  const restoreEditorState = useCallback(async () => {
    const appState = getAppState();
    if (!appState) return;
    state.current.isRestoringState = true;
    state.current.currentlyEditing = true;
    state.current.movedAway = false;

    if (!DDS.isTab) {
      tabBarRef.current?.goToPage(1, false);
    }
    clearAppState();
    state.current.isRestoringState = false;
  }, []);

  useEffect(() => {
    eSubscribeEvent(eOnLoadNote + editorId, loadNote);
    return () => {
      eUnSubscribeEvent(eOnLoadNote + editorId, loadNote);
    };
  }, [editorId, loadNote, restoreEditorState, isDefaultEditor]);

  const onContentChanged = (noteId?: string) => {
    if (noteId) {
      lastContentChangeTime.current[noteId] = Date.now();
    }
  };

  const onReady = useCallback(async () => {
    if (
      !(await isEditorLoaded(
        editorRef,
        sessionIdRef.current,
        useTabStore.getState().currentTab
      ))
    ) {
      eSendEvent(eEditorReset, "onReady");
      return false;
    } else {
      syncTabs();
      isDefaultEditor && restoreEditorState();
      return true;
    }
  }, [isDefaultEditor, restoreEditorState]);

  const onLoad = useCallback(async () => {
    setTimeout(() => {
      postMessage(NativeEvents.theme, theme);
    });
    commands.setInsets(
      isDefaultEditor ? insets : { top: 0, left: 0, right: 0, bottom: 0 }
    );
    await commands.setSettings();

    if (!state.current.ready) {
      state.current.ready = true;
    }

    const noteId = useTabStore.getState().getCurrentNoteId();

    if (!noteId) {
      loadNote({ newNote: true });
      if (tabBarRef.current?.page() === 1) {
        state.current.currentlyEditing = false;
      }
    } else if (state.current?.initialLoadCalled) {
      const note = currentNotes.current[noteId];
      if (note) {
        loadNote({
          item: note
        });
      }
    }
    if (!state.current?.initialLoadCalled) {
      state.current.initialLoadCalled = true;
    }
    overlay(false);
  }, [
    postMessage,
    theme,
    commands,
    isDefaultEditor,
    insets,
    loadNote,
    overlay
  ]);

  return {
    ref: editorRef,
    onLoad,
    commands,
    reset,
    loading,
    setLoading,
    state,
    sessionId: sessionIdRef,
    note: currentNotes,
    onReady,
    saveContent,
    onContentChanged,
    editorId: editorId,
    overlay,
    postMessage,
    currentLoadingNoteId
  };
};
