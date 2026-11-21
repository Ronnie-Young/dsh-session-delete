/**
 * dsh-session-delete — Client half: a Session recycle bin.
 *
 * Two surfaces:
 *   - the sidebar Session menu gains a "Move to trash" row (right click and the
 *     ellipsis button share one structured contribution). Choosing it opens a
 *     confirmation dialog copied from the host modal, then archives the Session
 *     (stops running work, clears the main view), asks the Host to move its log
 *     into the trash, drops the row locally, and offers "Restore" in the toast;
 *   - `sidebar.panellist` gets a "Trash" entry whose `main` page lists trashed
 *     Sessions with remaining days, Restore, permanent delete, and Clear all.
 *
 * The DSH session list itself (`sidebar.workspaces`) is a single occupied slot
 * owned by the shipped WorkspaceBrowser; a plugin cannot add a group to it
 * without replacing that whole region, so the bin lives behind the sidebar's
 * panel entry where it can be done properly.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    /** Locale namespace owned by this package. */
    const NS = 'sessionDelete'
    /** Host routes. */
    const MOVE_ROUTE = '/session-delete/trash/move'
    const TRASH_ROUTE = '/session-delete/trash'
    const TRASH_ACTION_ROUTE = '/session-delete/trash/action'
    const SETTINGS_ROUTE = '/session-delete/settings'
    /** Panel key shared by the sidebar entry and its main page. */
    const PANEL_KEY = 'session-delete'
    /** Keyed glyph rendered inside the shared menu row. */
    const ICON_KEY = 'session-delete.trash'
    /** Focusable elements the host modal's own trap accepts. */
    const FOCUSABLE = 'button:not(:disabled), [href], [tabindex="0"]'
    /** Longest Session title echoed into a toast. */
    const TOAST_TITLE_LIMIT = 40
    /** One day in milliseconds. */
    const DAY_MS = 86_400_000
    /** How often a mounted trash surface re-reads the Host list. */
    const TRASH_REFRESH_MS = 30_000

    const zh = {
      panelLabel: '回收站',
      menuLabel: '移到回收站',
      dialogTitle: '移到回收站？',
      dialogDescription: '会话「{title}」会被移到回收站，{days} 天内可以恢复，到期后{treatment}。',
      dialogDescriptionUntitled: '这个会话还没有标题。它会被移到回收站，{days} 天内可以恢复，到期后{treatment}。',
      dialogDescriptionGeneric: '会话会被移到回收站，之后可以恢复；超过保留期后会永久删除。',
      treatmentPurge: '自动永久删除',
      treatmentLock: '保留但不能再恢复，只能手动永久删除',
      dialogHint: '如果这个会话还有正在运行的工作，会先停止它。',
      dialogHintFailed: '会话已经停止；日志没能移入回收站，它仍在原来的分组里，可以直接重试。',
      dialogNotReady: '回收站需要重启 App 后才可用；会话没有被移入回收站，已放回原来的分组。',
      trashNotReady: '回收站需要重启 App 后才可用。',
      cancel: '取消',
      confirm: '移到回收站',
      working: '正在移动…',
      close: '关闭',
      success: '已移到回收站「{title}」',
      successUntitled: '已移到回收站',
      successEmpty: '这个会话已经不存在，已从列表中移除',
      undo: '恢复',
      undoFailed: '恢复没有完成，可以到回收站里重试。',
      failureArchive: '停止这个会话失败：{message}',
      failureTrash: '移到回收站失败：{message}',
      failureLabel: '会话没有移入回收站，请重试。',
      trashTitle: '回收站',
      trashSubtitle: '删除的会话会在这里保留 {days} 天，期间可以恢复；到期后{treatment}。',
      trashSubtitleGeneric: '删除的会话会先放在这里，可以恢复。',
      trashEmpty: '回收站是空的',
      trashEmptyHint: '在侧栏会话上右键，选「移到回收站」，会话就会出现在这里。',
      trashLoading: '正在读取回收站…',
      trashRefresh: '刷新',
      trashClearAll: '清空回收站',
      trashClearAllConfirm: '永久删除回收站里的 {count} 个会话？此操作无法撤销。',
      trashClearAllAction: '全部永久删除',
      trashRestore: '恢复',
      trashPurge: '永久删除',
      trashPurgeQuestion: '永久删除后无法恢复，确定吗？',
      trashPurgeAction: '确认永久删除',
      trashCancel: '取消',
      trashDeletedToday: '今天删除',
      trashDeletedYesterday: '昨天删除',
      trashDeletedDays: '{days} 天前删除',
      trashDeletedUnknown: '删除时间未知',
      trashDaysLeft: '还剩 {days} 天',
      trashNoExpiry: '不设期限',
      trashLocked: '已过期，不可恢复',
      trashMissing: '日志文件已丢失',
      trashUntitled: '无标题会话',
      trashRestored: '已恢复会话「{title}」',
      trashRestoredUntitled: '已恢复会话',
      trashPurged: '已永久删除会话「{title}」',
      trashPurgedUntitled: '已永久删除会话',
      trashPurgedAll: '已永久删除 {count} 个会话',
      trashPurgedAllFailed: '已永久删除 {count} 个会话，还有 {failed} 个没能删除，可以重试。',
      trashFailed: '回收站操作失败：{message}',
      trashCount: '{count} 个会话',
      settingsTitle: '设置',
      settingsRestartNote: '保存后插件会重启一次，新设置立刻生效。',
      settingsRetention: '保留天数',
      settingsDaysUnit: '天',
      settingsExpiry: '到期处理',
      settingsPurge: '自动永久删除',
      settingsPurgeHint: '到期后自动清掉，磁盘立刻释放。',
      settingsLock: '保留但不可恢复',
      settingsLockHint: '到期后数据还在，但恢复按钮失效，需要你手动永久删除。',
      settingsSave: '保存设置',
      settingsSaving: '正在保存…',
      settingsSaved: '设置已保存',
      settingsInvalid: '保留天数需要在 1 到 365 之间。',
      settingsFailed: '设置保存失败：{message}',
      settingsNotReady: '回收站的宿主端还没加载，重启 App 后才能保存设置。',
      settingsUnavailable: '当前 profile 不能从这里保存设置；请改 profile 的 cordis.patch.yml，或在 Plugins 页里改插件配置。',
    }

    const en = {
      panelLabel: 'Trash',
      menuLabel: 'Move to trash',
      dialogTitle: 'Move this session to the trash?',
      dialogDescription: 'The session “{title}” moves to the trash and can be restored for {days} days; after that it {treatment}.',
      dialogDescriptionUntitled: 'This untitled session moves to the trash and can be restored for {days} days; after that it {treatment}.',
      dialogDescriptionGeneric: 'The session moves to the trash and can be restored later; it is permanently deleted after the retention period.',
      treatmentPurge: 'is permanently deleted automatically',
      treatmentLock: 'is kept but can no longer be restored, and must be permanently deleted by hand',
      dialogHint: 'If the session is still running work, that work stops first.',
      dialogHintFailed: 'The session was stopped; its log could not be moved to the trash. It is back in its workspace, so you can try again.',
      dialogNotReady: 'The trash needs an app restart before it can be used. Nothing was moved, and the session is back in its workspace.',
      trashNotReady: 'The trash needs an app restart before it can be used.',
      cancel: 'Cancel',
      confirm: 'Move to trash',
      working: 'Moving…',
      close: 'Close',
      success: 'Moved “{title}” to the trash',
      successUntitled: 'Moved to the trash',
      successEmpty: 'This session no longer exists and was removed from the list',
      undo: 'Restore',
      undoFailed: 'The restore did not finish; try again from the trash.',
      failureArchive: 'Could not stop this session: {message}',
      failureTrash: 'Could not move to the trash: {message}',
      failureLabel: 'The session was not moved to the trash; try again.',
      trashTitle: 'Trash',
      trashSubtitle: 'Deleted sessions stay here for {days} days and can be restored; after that they {treatment}.',
      trashSubtitleGeneric: 'Deleted sessions stay here until you permanently delete them.',
      trashEmpty: 'The trash is empty',
      trashEmptyHint: 'Right-click a session in the sidebar and choose Move to trash; it appears here.',
      trashLoading: 'Reading the trash…',
      trashRefresh: 'Refresh',
      trashClearAll: 'Clear the trash',
      trashClearAllConfirm: 'Permanently delete all {count} sessions in the trash? This cannot be undone.',
      trashClearAllAction: 'Delete all permanently',
      trashRestore: 'Restore',
      trashPurge: 'Delete permanently',
      trashPurgeQuestion: 'This cannot be undone. Delete it permanently?',
      trashPurgeAction: 'Delete permanently',
      trashCancel: 'Cancel',
      trashDeletedToday: 'Deleted today',
      trashDeletedYesterday: 'Deleted yesterday',
      trashDeletedDays: 'Deleted {days} days ago',
      trashDeletedUnknown: 'Deletion time unknown',
      trashDaysLeft: '{days} days left',
      trashNoExpiry: 'No expiry',
      trashLocked: 'Expired, cannot be restored',
      trashMissing: 'The log file is gone',
      trashUntitled: 'Untitled session',
      trashRestored: 'Restored “{title}”',
      trashRestoredUntitled: 'Session restored',
      trashPurged: 'Permanently deleted “{title}”',
      trashPurgedUntitled: 'Session permanently deleted',
      trashPurgedAll: 'Permanently deleted {count} sessions',
      trashPurgedAllFailed: 'Permanently deleted {count} sessions; {failed} could not be deleted and can be retried.',
      trashFailed: 'Trash action failed: {message}',
      trashCount: '{count} sessions',
      settingsTitle: 'Settings',
      settingsRestartNote: 'The plugin restarts once after saving, so the new policy applies immediately.',
      settingsRetention: 'Keep for',
      settingsDaysUnit: 'days',
      settingsExpiry: 'When the period ends',
      settingsPurge: 'Delete automatically',
      settingsPurgeHint: 'The log is removed as soon as the retention period ends.',
      settingsLock: 'Keep, but lock',
      settingsLockHint: 'The log stays, restoring is no longer possible, and you delete it by hand.',
      settingsSave: 'Save settings',
      settingsSaving: 'Saving…',
      settingsSaved: 'Settings saved',
      settingsInvalid: 'The retention must be an integer between 1 and 365.',
      settingsFailed: 'Could not save the settings: {message}',
      settingsNotReady: 'The trash Host half is not loaded yet; restart the app to save settings.',
      settingsUnavailable: 'This profile cannot save plugin configuration from here; edit the row in the profile cordis.patch.yml or use the Plugins page.',
    }

    /** Modal and trash-page styles; colors are theme tokens. */
    const CSS = `
.dshsd-root {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px;
  pointer-events: auto;
}
.dshsd-mask {
  position: absolute; inset: var(--dsh-frame-chrome-top, 0px) 0 0;
  backdrop-filter: var(--dsw-mask-blur);
}
.dshsd-mask::after {
  content: ''; position: absolute; inset: 0;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24));
  animation: dshsd-fade var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-out);
}
.dshsd-dialog {
  box-sizing: border-box; position: relative; z-index: 1;
  display: flex; flex-direction: column; gap: 20px;
  width: min(400px, 100%); max-height: 100%; padding: 0 0 24px; overflow: hidden;
  border: 0; border-radius: var(--dsw-radius-panel, 28px);
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.16));
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  animation: dshsd-fade var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease-out);
}
.dshsd-dialog:focus { outline: none; }
.dshsd-content {
  display: flex; flex-direction: column; width: 100%;
  min-height: 0; overflow-y: auto; overscroll-behavior: contain;
}
.dshsd-header {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 22px 14px 12px 24px;
}
.dshsd-title {
  display: flex; align-items: flex-start; gap: 8px;
  margin: 0; font-size: 16px; line-height: 24px; font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dshsd-title-icon { flex: none; margin-top: 3px; color: var(--dsw-alias-state-warn-primary) }
.dshsd-close {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: var(--dsw-radius-sm, 8px);
  background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary);
}
.dshsd-close[aria-disabled="true"] { cursor: not-allowed; opacity: 0.4 }
@media (hover: hover) { .dshsd-close:hover:not([aria-disabled="true"]) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)) } }
.dshsd-close:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)));
  outline-offset: 2px;
}
.dshsd-description {
  margin: 0; padding: 0 24px; font-size: 14px; line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.dshsd-hint {
  margin: 6px 0 0; padding: 0 24px; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dshsd-error {
  margin: 14px 24px 0; padding: 10px 12px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px; line-height: 20px; overflow-wrap: anywhere;
}
.dshsd-footer {
  display: flex; align-items: center; justify-content: flex-end;
  gap: 8px; padding: 0 24px;
}
.dshsd-button {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  gap: 4px; height: 36px; min-width: 72px; padding: 0 14px;
  border: none; border-radius: var(--dsw-radius-md, 12px); cursor: pointer;
  font-family: inherit; font-size: 14px; line-height: 22px;
  color: var(--dsw-alias-label-primary); background: transparent;
}
.dshsd-button:disabled, .dshsd-button[aria-disabled="true"] { cursor: not-allowed; opacity: 0.4 }
.dshsd-button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)));
  outline-offset: 2px;
}
.dshsd-button-outline {
  box-shadow: inset 0 0 0 var(--dsh-hairline-width, 0.5px) var(--dsh-button-outline-color, var(--dsw-alias-border-l2));
}
@media (hover: hover) { .dshsd-button-outline:hover:not([aria-disabled="true"]) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)) } }
.dshsd-button-primary {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
}
@media (hover: hover) {
  .dshsd-button-primary:hover:not([aria-disabled="true"]) {
    background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));
  }
}
@keyframes dshsd-fade { from { opacity: 0 } to { opacity: 1 } }
@media (prefers-reduced-motion: reduce) {
  .dshsd-mask::after, .dshsd-dialog { animation: none }
}

.dshsd-page {
  height: 100%; overflow: auto; box-sizing: border-box;
  padding: 24px 30px 48px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
}
.dshsd-page-wrap {
  max-width: 880px; margin: 0 auto;
  display: flex; flex-direction: column; gap: 18px;
}
.dshsd-page-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 16px; flex-wrap: wrap;
}
.dshsd-page-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600 }
.dshsd-page-sub {
  margin: 6px 0 0; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-secondary); max-width: 62ch;
}
.dshsd-page-tools { display: flex; align-items: center; gap: 8px; flex: none }
.dshsd-list { display: flex; flex-direction: column; gap: 8px }
.dshsd-row {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 14px; box-sizing: border-box;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l1);
}
.dshsd-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px }
.dshsd-row-title {
  font-size: 14px; line-height: 20px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dshsd-row-meta {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dshsd-dot { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: 0.5 }
.dshsd-warn { color: var(--dsw-alias-state-warn-primary) }
.dshsd-row-actions { display: flex; align-items: center; gap: 6px; flex: none }
.dshsd-small {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  height: 28px; padding: 0 10px; border: none; border-radius: var(--dsw-radius-sm, 8px);
  font-family: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: transparent;
}
.dshsd-small:disabled, .dshsd-small[aria-disabled="true"] { cursor: not-allowed; opacity: 0.4 }
.dshsd-small:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)));
  outline-offset: 2px;
}
.dshsd-small-outline { box-shadow: inset 0 0 0 var(--dsh-hairline-width, 0.5px) var(--dsh-button-outline-color, var(--dsw-alias-border-l2)) }
@media (hover: hover) { .dshsd-small-outline:hover:not(:disabled):not([aria-disabled="true"]) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)) } }
.dshsd-small-danger { color: var(--dsw-alias-state-error-primary) }
@media (hover: hover) { .dshsd-small-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent) } }
.dshsd-small-primary {
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
}
.dshsd-confirm {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary);
}
.dshsd-settings {
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-1);
  padding: 16px; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 14px;
}
.dshsd-settings-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600 }
.dshsd-settings-hint {
  margin: 4px 0 0; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dshsd-settings-body { display: flex; flex-direction: column; gap: 14px }
.dshsd-field { display: flex; align-items: center; gap: 12px; flex-wrap: wrap }
.dshsd-field-label { min-width: 76px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary) }
.dshsd-field-input { display: inline-flex; align-items: center; gap: 6px }
.dshsd-input {
  width: 88px; height: 32px; box-sizing: border-box; padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 13px; line-height: 20px;
}
.dshsd-input:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)));
  outline-offset: 2px;
}
.dshsd-field-unit { font-size: 12px; color: var(--dsw-alias-label-secondary) }
.dshsd-options { display: flex; gap: 8px; flex-wrap: wrap; flex: 1 1 320px }
.dshsd-option {
  flex: 1 1 200px; display: flex; flex-direction: column; gap: 4px;
  padding: 10px 12px; box-sizing: border-box; text-align: left; cursor: pointer;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font-family: inherit;
}
.dshsd-option[aria-checked="true"] {
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-base));
}
.dshsd-option:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)));
  outline-offset: 2px;
}
.dshsd-option-title { font-size: 13px; line-height: 20px; font-weight: 500 }
.dshsd-option-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary) }
.dshsd-settings-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap }
.dshsd-settings-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere }
.dshsd-empty {
  padding: 56px 0; text-align: center;
  color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px;
}
.dshsd-empty-title { color: var(--dsw-alias-label-primary); font-size: 15px; line-height: 22px; margin: 0 0 6px }
.dshsd-empty-hint { margin: 0; font-size: 13px; line-height: 20px }
.dshsd-notice {
  padding: 10px 12px; border-radius: var(--dsw-radius-sm, 8px);
  font-size: 13px; line-height: 20px; overflow-wrap: anywhere;
}
.dshsd-notice-error {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.dshsd-count {
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dshsd-icon-wrap {
  position: relative; display: grid; place-items: center;
  color: var(--dsw-alias-label-secondary);
}
.dshsd-icon-wrap[data-active="true"] { color: var(--dsw-alias-brand-primary) }
.dshsd-icon-badge {
  position: absolute; top: -3px; right: -5px;
  min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box;
  border-radius: 999px; background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
  font-size: 10px; line-height: 14px; text-align: center; font-variant-numeric: tabular-nums;
}
@media (prefers-reduced-motion: reduce) {
  .dshsd-page, .dshsd-list { scroll-behavior: auto }
}
`

    // ---- shared state -------------------------------------------------------

    /** The move-to-trash dialog request shown right now, or null. */
    const dialogState = { value: null }
    const dialogListeners = new Set()

    /** Last Host trash snapshot plus its load state, shared by icon and page. */
    const trashState = { value: null, error: null, errorCode: null, loading: false, inflight: null }
    const trashListeners = new Set()

    let t = (key) => key
    let ctx = null

    /**
     * Publish a dialog request to the mounted overlay.
     * @param next - request object, or null to close.
     */
    function publishDialog(next) {
      dialogState.value = next
      for (const listener of dialogListeners) {
        try {
          listener()
        } catch { /* a broken overlay listener must not block the action */ }
      }
    }

    /**
     * Merge one field set into the open dialog request.
     * @param patch - fields to replace.
     */
    function updateDialog(patch) {
      if (dialogState.value === null) return
      publishDialog({ ...dialogState.value, ...patch })
    }

    /**
     * Publish one trash-state change to both surfaces.
     * @param patch - fields to replace.
     */
    function publishTrash(patch) {
      Object.assign(trashState, patch)
      for (const listener of trashListeners) {
        try {
          listener()
        } catch { /* a broken surface must not block the others */ }
      }
    }

    /**
     * Open the confirmation dialog for one captured Session row.
     * @param request - Session id and current row title.
     */
    function openConfirm(request) {
      publishDialog({
        sessionId: request.sessionId,
        displayTitle: typeof request.displayTitle === 'string' ? request.displayTitle : '',
        phase: 'confirm',
        error: null,
        archived: false,
        stage: null,
      })
      // Learn the retention policy so the copy can name the days.
      void loadTrash()
    }

    /**
     * Close the dialog unless the move is in flight.
     */
    function requestClose() {
      if (dialogState.value === null || dialogState.value.phase === 'working') return
      publishDialog(null)
    }

    /**
     * Truncate a title for a toast.
     * @param title - Session title.
     * @returns one short line.
     */
    function shorten(title) {
      const text = String(title ?? '').trim()
      return text.length > TOAST_TITLE_LIMIT ? `${text.slice(0, TOAST_TITLE_LIMIT - 1)}…` : text
    }

    /**
     * The archive refusal for an id with no stored Session is not a failure.
     * @param error - rejection from the archive call.
     * @returns whether the Session simply does not exist.
     */
    function isUnknownSession(error) {
      const message = error instanceof Error ? error.message : String(error)
      return /hold no such session|not found|already deleted/i.test(message)
    }

    /**
     * Install the stylesheet for the Client lifetime.
     * @returns cleanup.
     */
    function installStyles() {
      const element = document.createElement('style')
      element.setAttribute('data-dsh-plugin-style', 'session-delete')
      element.textContent = CSS
      document.head.appendChild(element)
      return () => {
        element.remove()
      }
    }

    /**
     * One same-origin JSON request to the Host half.
     * @param url - route.
     * @param init - fetch init; JSON bodies pass through as objects.
     * @returns the parsed payload, or throws a coded Error.
     */
    async function requestJson(url, init = {}) {
      const headers = { accept: 'application/json', ...(init.headers ?? {}) }
      const request = { credentials: 'same-origin', method: init.method ?? 'GET', headers }
      if (init.body !== undefined) {
        headers['content-type'] = 'application/json'
        request.body = JSON.stringify(init.body)
      }
      const response = await fetch(url, request)
      // An older Host generation refuses unknown paths (404) and answers a
      // POST to one with 405 from the fallback: both mean "restart to activate".
      if (response.status === 404 || response.status === 405) {
        const missing = new Error('the Host does not serve this route yet')
        missing.code = 'ROUTE_NOT_READY'
        throw missing
      }
      let payload = null
      try {
        payload = await response.json()
      } catch { /* a non-JSON refusal is reported below */ }
      if (payload === null || typeof payload !== 'object') {
        throw new Error(`the Host answered HTTP ${response.status}`)
      }
      if (response.ok !== true || payload.ok !== true) {
        const failure = new Error(payload.error?.message ?? `the Host refused the request (HTTP ${response.status})`)
        failure.code = payload.error?.code
        throw failure
      }
      return payload
    }

    /**
     * Re-read the Host trash list, sharing one in-flight request.
     * @returns resolution after the state publishes.
     */
    function loadTrash() {
      if (trashState.inflight !== null) return trashState.inflight
      publishTrash({ loading: true })
      const run = requestJson(TRASH_ROUTE).then(
        payload => publishTrash({ value: payload, error: null, errorCode: null, loading: false }),
        (error) => {
          publishTrash({
            error: error instanceof Error ? error.message : String(error),
            errorCode: error?.code ?? null,
            loading: false,
          })
        },
      ).finally(() => {
        trashState.inflight = null
      })
      trashState.inflight = run
      return run
    }

    /**
     * Re-read the trash after the Host plugin restarted for a config change;
     * a brief route gap during that restart must not look like a missing build.
     * @param delayMs - first attempt delay.
     * @param retries - remaining attempts.
     */
    function reloadTrashSoon(delayMs, retries) {
      setTimeout(() => {
        void loadTrash().then(() => {
          if (trashState.errorCode === 'ROUTE_NOT_READY' && retries > 0) reloadTrashSoon(800, retries - 1)
        })
      }, delayMs)
    }

    /**
     * Subscribe a component to both shared stores.
     * @returns nothing; the caller re-renders through setState.
     */
    function useSharedState() {
      const [, setRevision] = useState(0)
      useEffect(() => {
        const bump = () => setRevision(value => value + 1)
        dialogListeners.add(bump)
        trashListeners.add(bump)
        return () => {
          dialogListeners.delete(bump)
          trashListeners.delete(bump)
        }
      }, [])
    }

    /**
     * Show one toast through the shared menu service.
     * @param text - localized message.
     * @param success - success styling.
     * @param action - optional text action.
     */
    function notify(text, success, action) {
      try {
        if (action === undefined) ctx.contextMenus.notify(text, success)
        else ctx.contextMenus.notify(text, success, action)
      } catch { /* a build without the shared toast must not fail the operation */ }
    }

    // ---- move to trash ------------------------------------------------------

    /**
     * Run the confirmed move. The client archives first (stop running work and
     * clear the main view), then the Host moves the log, then the row leaves
     * the local catalog and the toast offers an undo.
     * @returns resolution after the dialog or error state settles.
     */
    async function confirmTrash() {
      const state = dialogState.value
      if (state === null || state.phase === 'working') return
      const { sessionId, displayTitle } = state
      let archived = false
      updateDialog({ phase: 'working', error: null, archived: false, stage: null })

      try {
        const uiWorkspace = ctx.get('uiWorkspace')
        if (uiWorkspace !== undefined && typeof uiWorkspace.archiveSession === 'function') {
          try {
            await uiWorkspace.archiveSession(sessionId, { stopActivity: true })
            archived = true
          } catch (error) {
            if (!isUnknownSession(error)) {
              updateDialog({
                phase: 'error',
                archived: false,
                stage: 'archive',
                error: t('failureArchive', { message: error instanceof Error ? error.message : String(error) }),
              })
              return
            }
          }
        }

        const payload = await requestJson(MOVE_ROUTE, {
          method: 'POST',
          body: { sessionId, displayTitle },
        })
        publishDialog(null)

        const empty = payload.empty === true
        const title = shorten(displayTitle)
        const message = empty
          ? t('successEmpty')
          : title === ''
            ? t('successUntitled')
            : t('success', { title })
        if (empty) notify(message, true)
        else {
          notify(message, true, {
            label: t('undo'),
            failureLabel: t('undoFailed'),
            run: () => restoreSession(sessionId, displayTitle),
          })
        }

        const sessions = ctx.get('sessions')
        if (sessions !== undefined && typeof sessions.handleSessionRemoved === 'function') {
          try {
            sessions.handleSessionRemoved(sessionId)
          } catch { /* removing the row must not fail the move */ }
        }
        void loadTrash()
      } catch (error) {
        if (error?.code === 'ROUTE_NOT_READY') {
          // The running Host generation predates the trash: it has no move
          // route, so nothing left the disk. Undo the archive and say what to do.
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace !== undefined && typeof uiWorkspace.unarchiveSession === 'function') {
            await uiWorkspace.unarchiveSession(sessionId).catch(() => undefined)
          }
          updateDialog({ phase: 'error', archived: false, stage: 'unavailable', error: t('dialogNotReady') })
          return
        }
        updateDialog({
          phase: 'error',
          archived,
          stage: archived ? 'move' : 'archive',
          error: t('failureTrash', { message: error instanceof Error ? error.message : String(error) }),
        })
      }
    }

    /**
     * Restore one trashed Session and make it visible again.
     * @param sessionId - Session to restore.
     * @param displayTitle - title for the toast.
     * @returns resolution after the toast.
     */
    async function restoreSession(sessionId, displayTitle) {
      try {
        const payload = await requestJson(TRASH_ACTION_ROUTE, {
          method: 'POST',
          body: { action: 'restore', sessionId },
        })
        const title = shorten(payload.title ?? displayTitle ?? '')
        notify(title === '' ? t('trashRestoredUntitled') : t('trashRestored', { title }), true)
        const sessions = ctx.get('sessions')
        if (sessions !== undefined && typeof sessions.refresh === 'function') {
          // The log is back; the catalog needs one pull to carry the row again.
          void Promise.resolve(sessions.refresh()).catch(() => undefined)
          setTimeout(() => {
            void Promise.resolve(sessions.refresh?.()).catch(() => undefined)
          }, 400)
        }
        void loadTrash()
      } catch (error) {
        notify(t('trashFailed', { message: error instanceof Error ? error.message : String(error) }), false)
      }
    }

    /**
     * Permanently delete one trashed Session.
     * @param sessionId - Session to purge.
     * @returns resolution after the toast.
     */
    async function purgeSession(sessionId, displayTitle) {
      try {
        const payload = await requestJson(TRASH_ACTION_ROUTE, {
          method: 'POST',
          body: { action: 'purge', sessionId },
        })
        const title = shorten(payload.title ?? displayTitle ?? '')
        notify(title === '' ? t('trashPurgedUntitled') : t('trashPurged', { title }), true)
        void loadTrash()
      } catch (error) {
        notify(t('trashFailed', { message: error instanceof Error ? error.message : String(error) }), false)
      }
    }

    /**
     * Permanently delete every trashed Session.
     * @returns resolution after the toast.
     */
    async function purgeAllSessions() {
      try {
        const payload = await requestJson(TRASH_ACTION_ROUTE, {
          method: 'POST',
          body: { action: 'purge-all' },
        })
        const purged = String(payload.purged ?? 0)
        const failed = Number(payload.failed ?? 0)
        notify(
          failed > 0
            ? t('trashPurgedAllFailed', { count: purged, failed: String(failed) })
            : t('trashPurgedAll', { count: purged }),
          failed === 0,
        )
        void loadTrash()
      } catch (error) {
        notify(t('trashFailed', { message: error instanceof Error ? error.message : String(error) }), false)
      }
    }

    // ---- components ---------------------------------------------------------

    /**
     * Confirmation dialog; renders nothing while no request is pending.
     * @returns the overlay tree.
     */
    function DeleteConfirmDialog() {
      useSharedState()
      const dialogRef = useRef(null)
      const restoreFocusRef = useRef(null)
      const open = dialogState.value !== null
      const trash = trashState.value

      useEffect(() => {
        if (!open) return
        const node = dialogRef.current
        if (node === null) return
        const active = document.activeElement
        restoreFocusRef.current = active instanceof HTMLElement ? active : null
        if (!node.contains(active)) {
          const target = node.querySelector('[data-dshsd-autofocus]')
            ?? node.querySelector(FOCUSABLE)
            ?? node
          target.focus({ preventScroll: true })
        }
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
          if (event.key === 'Escape' && !event.shiftKey) {
            event.preventDefault()
            if (!event.repeat) requestClose()
            return
          }
          if (event.key !== 'Tab') return
          const focusable = [...node.querySelectorAll(FOCUSABLE)]
            .filter(element => element.closest('[inert], [hidden]') === null)
          const first = focusable[0] ?? node
          const last = focusable[focusable.length - 1] ?? node
          const outside = !node.contains(document.activeElement)
          if (outside || (event.shiftKey && document.activeElement === first)) {
            event.preventDefault()
            ;(event.shiftKey ? first : last).focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          const restore = restoreFocusRef.current
          restoreFocusRef.current = null
          if (restore !== null && restore.isConnected) restore.focus({ preventScroll: true })
        }
      }, [open])

      if (!open) return null
      const state = dialogState.value
      const working = state.phase === 'working'
      const title = state.displayTitle.trim()
      const retentionDays = trash?.retentionDays
      const treatment = trash?.expireAction === 'lock' ? t('treatmentLock') : t('treatmentPurge')
      const description = typeof retentionDays === 'number' && retentionDays > 0
        ? title === ''
          ? t('dialogDescriptionUntitled', { days: String(retentionDays), treatment })
          : t('dialogDescription', { title, days: String(retentionDays), treatment })
        : t('dialogDescriptionGeneric')
      const hint = state.phase === 'error' && state.archived ? t('dialogHintFailed') : t('dialogHint')
      const confirmLabel = working
        ? t('working')
        : state.phase === 'error'
          ? t('confirm')
          : t('confirm')

      return h('div', { className: 'dshsd-root', role: 'presentation' }, [
        h('div', {
          key: 'mask',
          className: 'dshsd-mask',
          'aria-hidden': true,
          onClick: () => requestClose(),
        }),
        h('div', {
          key: 'dialog',
          ref: dialogRef,
          className: 'dshsd-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dshsd-title',
          'aria-describedby': 'dshsd-description',
          'aria-busy': working,
          tabIndex: -1,
        }, [
          h('div', { key: 'content', className: 'dshsd-content' }, [
            h('div', { key: 'header', className: 'dshsd-header' }, [
              h('h2', { key: 'title', className: 'dshsd-title', id: 'dshsd-title' }, [
                h('svg', {
                  key: 'icon',
                  className: 'dshsd-title-icon',
                  viewBox: '0 0 24 24',
                  width: 18,
                  height: 18,
                  'aria-hidden': true,
                  style: { display: 'block', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
                }, [
                  h('path', { key: 'triangle', d: 'M12 4.6 3.8 19h16.4L12 4.6Z' }),
                  h('path', { key: 'mark', d: 'M12 10v4.2' }),
                  h('circle', { key: 'dot', cx: 12, cy: 17.1, r: 0.1, style: { fill: 'currentColor' } }),
                ]),
                h('span', { key: 'text' }, t('dialogTitle')),
              ]),
              h('button', {
                key: 'close',
                type: 'button',
                className: 'dshsd-close',
                'aria-label': t('close'),
                'aria-disabled': working,
                onClick: () => requestClose(),
              }, h('svg', {
                viewBox: '0 0 24 24',
                width: 14,
                height: 14,
                'aria-hidden': true,
                style: { display: 'block', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' },
              }, [
                h('path', { key: 'a', d: 'M6 6l12 12' }),
                h('path', { key: 'b', d: 'M18 6L6 18' }),
              ])),
            ]),
            h('p', { key: 'description', className: 'dshsd-description', id: 'dshsd-description' }, description),
            h('p', { key: 'hint', className: 'dshsd-hint' }, hint),
            state.error === null
              ? null
              : h('div', { key: 'error', className: 'dshsd-error', role: 'alert' }, state.error),
          ]),
          h('div', { key: 'footer', className: 'dshsd-footer' }, [
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'dshsd-button dshsd-button-outline',
              'data-dshsd-autofocus': true,
              'aria-disabled': working,
              onClick: () => requestClose(),
            }, t('cancel')),
            h('button', {
              key: 'confirm',
              type: 'button',
              className: 'dshsd-button dshsd-button-primary',
              'aria-disabled': working,
              onClick: () => { void confirmTrash() },
            }, confirmLabel),
          ]),
        ]),
      ])
    }

    /**
     * One trashed Session's meta line.
     * @param props - entry, locale, and current time.
     * @returns the meta row.
     */
    function entryMeta({ entry, t: translate, now }) {
      const parts = []
      const daysAgo = entry.deletedAt > 0 ? Math.floor((now - entry.deletedAt) / DAY_MS) : null
      if (daysAgo === null) parts.push(translate('trashDeletedUnknown'))
      else if (daysAgo <= 0) parts.push(translate('trashDeletedToday'))
      else if (daysAgo === 1) parts.push(translate('trashDeletedYesterday'))
      else parts.push(translate('trashDeletedDays', { days: String(daysAgo) }))

      let expiry
      if (entry.locked) expiry = h('span', { key: 'expiry', className: 'dshsd-warn' }, translate('trashLocked'))
      else if (entry.expiresAt === 0) expiry = translate('trashNoExpiry')
      else if (typeof entry.daysLeft === 'number') expiry = translate('trashDaysLeft', { days: String(entry.daysLeft) })
      if (expiry !== undefined) {
        parts.push(h('span', { key: 'sep', className: 'dshsd-dot', 'aria-hidden': true }))
        parts.push(h('span', { key: 'expiry' }, expiry))
      }
      if (!entry.hasFiles) {
        parts.push(h('span', { key: 'sep2', className: 'dshsd-dot', 'aria-hidden': true }))
        parts.push(h('span', { key: 'missing', className: 'dshsd-warn' }, translate('trashMissing')))
      }
      return parts
    }

    /**
     * The recycle-bin page in the main column.
     * @param props - locale translate from the slot.
     * @returns the page tree.
     */
    function TrashPage(props) {
      const translate = typeof props?.t === 'function' ? props.t : t
      useSharedState()
      const [pending, setPending] = useState(null)
      const [now, setNow] = useState(() => Date.now())
      const [daysDraft, setDaysDraft] = useState(null)
      const [actionDraft, setActionDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const [saveError, setSaveError] = useState(null)
      const seededRef = useRef(false)

      useEffect(() => {
        void loadTrash()
        const timer = setInterval(() => {
          setNow(Date.now())
          void loadTrash()
        }, TRASH_REFRESH_MS)
        const onVisible = () => {
          if (document.visibilityState === 'visible') void loadTrash()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      const data = trashState.value
      const entries = Array.isArray(data?.entries) ? data.entries : []

      // Seed the form from the Host policy once; a periodic poll must not
      // overwrite a draft the user is still editing.
      useEffect(() => {
        if (seededRef.current || data === null) return
        seededRef.current = true
        setDaysDraft(String(data.retentionDays ?? ''))
        setActionDraft(data.expireAction === 'lock' ? 'lock' : 'purge')
      }, [data])

      // Fall back to the Host policy until a draft exists, so the form renders
      // correctly even before the seeding effect has run.
      const daysShown = daysDraft ?? (data === null ? '' : String(data.retentionDays ?? ''))
      const actionShown = actionDraft ?? (data?.expireAction === 'lock' ? 'lock' : 'purge')

      /*
       * Persist the retention policy. The Host writes it through the config
       * editor, which restarts the plugin so `apply` rebuilds its state.
       */
      async function saveSettings() {
        const days = Number(daysShown)
        if (!Number.isInteger(days) || days < 1 || days > 365) {
          setSaveError(translate('settingsInvalid'))
          return
        }
        setSaving(true)
        setSaveError(null)
        try {
          await requestJson(SETTINGS_ROUTE, {
            method: 'POST',
            body: { retentionDays: days, expireAction: actionShown === 'lock' ? 'lock' : 'purge' },
          })
          notify(translate('settingsSaved'), true)
          reloadTrashSoon(900, 3)
        } catch (failure) {
          setSaveError(failure?.code === 'ROUTE_NOT_READY'
            ? translate('settingsNotReady')
            : translate('settingsFailed', {
              message: failure instanceof Error ? failure.message : String(failure),
            }))
        } finally {
          setSaving(false)
        }
      }
      const loading = trashState.loading
      const error = trashState.error
      const retentionDays = data?.retentionDays
      const treatment = data?.expireAction === 'lock' ? translate('treatmentLock') : translate('treatmentPurge')
      const subtitle = typeof retentionDays === 'number' && retentionDays > 0
        ? translate('trashSubtitle', { days: String(retentionDays), treatment })
        : translate('trashSubtitleGeneric')
      const busy = pending?.kind === 'purge' || pending?.kind === 'purge-all'

      const header = h('div', { className: 'dshsd-page-head', key: 'head' }, [
        h('div', { key: 'titles' }, [
          h('h1', { className: 'dshsd-page-title' }, translate('trashTitle')),
          h('p', { className: 'dshsd-page-sub' }, subtitle),
        ]),
        h('div', { className: 'dshsd-page-tools', key: 'tools' }, [
          h('span', { key: 'count', className: 'dshsd-count' }, translate('trashCount', { count: String(entries.length) })),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'dshsd-small dshsd-small-outline',
            onClick: () => { void loadTrash() },
          }, translate('trashRefresh')),
          entries.length === 0
            ? null
            : h('button', {
                key: 'clear',
                type: 'button',
                className: 'dshsd-small dshsd-small-danger',
                'aria-disabled': busy,
                onClick: () => setPending({ kind: 'purge-all' }),
              }, translate('trashClearAll')),
        ]),
      ])

      let body
      if (entries.length > 0) {
        body = h('div', { className: 'dshsd-list', key: 'list', role: 'list' }, entries.map((entry) => {
          const confirming = pending?.kind === 'purge' && pending.sessionId === entry.sessionId
          const titleText = entry.title.trim() === '' ? translate('trashUntitled') : entry.title
          const main = h('div', { className: 'dshsd-row-main', key: 'main' }, [
            h('div', { className: 'dshsd-row-title', title: entry.title }, titleText),
            h('div', { className: 'dshsd-row-meta' }, entryMeta({ entry, t: translate, now })),
          ])
          const actions = confirming
            ? h('div', { className: 'dshsd-confirm', key: 'actions' }, [
                h('span', { key: 'q' }, translate('trashPurgeQuestion')),
                h('button', {
                  key: 'cancel',
                  type: 'button',
                  className: 'dshsd-small dshsd-small-outline',
                  onClick: () => setPending(null),
                }, translate('trashCancel')),
                h('button', {
                  key: 'ok',
                  type: 'button',
                  className: 'dshsd-small dshsd-small-danger',
                  onClick: () => {
                    setPending(null)
                    void purgeSession(entry.sessionId, entry.title)
                  },
                }, translate('trashPurgeAction')),
              ])
            : h('div', { className: 'dshsd-row-actions', key: 'actions' }, [
                entry.restorable
                  ? h('button', {
                      key: 'restore',
                      type: 'button',
                      className: 'dshsd-small dshsd-small-outline',
                      'aria-disabled': busy,
                      onClick: () => { if (!busy) void restoreSession(entry.sessionId, entry.title) },
                    }, translate('trashRestore'))
                  : null,
                h('button', {
                  key: 'purge',
                  type: 'button',
                  className: 'dshsd-small dshsd-small-danger',
                  'aria-disabled': busy,
                  onClick: () => { if (!busy) setPending({ kind: 'purge', sessionId: entry.sessionId }) },
                }, translate('trashPurge')),
              ])
          return h('div', { className: 'dshsd-row', key: entry.sessionId, role: 'listitem' }, [main, actions])
        }))
      } else if (loading && data === null) {
        body = h('div', { className: 'dshsd-empty', key: 'loading' }, translate('trashLoading'))
      } else if (error !== null) {
        body = h('div', { className: 'dshsd-list', key: 'error' }, h('div', {
          className: 'dshsd-notice dshsd-notice-error',
          role: 'alert',
        }, trashState.errorCode === 'ROUTE_NOT_READY'
          ? translate('trashNotReady')
          : translate('trashFailed', { message: error })))
      } else {
        body = h('div', { className: 'dshsd-empty', key: 'empty' }, [
          h('p', { className: 'dshsd-empty-title', key: 'title' }, translate('trashEmpty')),
          h('p', { className: 'dshsd-empty-hint', key: 'hint' }, translate('trashEmptyHint')),
        ])
      }

      const notices = []
      if (error !== null && entries.length > 0) {
        notices.push(h('div', { key: 'error', className: 'dshsd-notice dshsd-notice-error', role: 'alert' },
          trashState.errorCode === 'ROUTE_NOT_READY'
            ? translate('trashNotReady')
            : translate('trashFailed', { message: error })))
      }
      if (pending?.kind === 'purge-all') {
        notices.push(h('div', { key: 'confirm', className: 'dshsd-confirm' }, [
          h('span', { key: 'q' }, translate('trashClearAllConfirm', { count: String(entries.length) })),
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dshsd-small dshsd-small-outline',
            onClick: () => setPending(null),
          }, translate('trashCancel')),
          h('button', {
            key: 'ok',
            type: 'button',
            className: 'dshsd-small dshsd-small-danger',
            onClick: () => {
              setPending(null)
              void purgeAllSessions()
            },
          }, translate('trashClearAllAction')),
        ]))
      }

      const daysNumber = Number(daysShown)
      const dirty = data === null
        ? false
        : (Number.isInteger(daysNumber) ? daysNumber !== data.retentionDays : true)
          || actionShown !== data.expireAction
      const settings = data === null
        ? null
        : h('section', { className: 'dshsd-settings', key: 'settings' }, [
          h('div', { key: 'head' }, [
            h('h2', { className: 'dshsd-settings-title' }, translate('settingsTitle')),
            h('p', { className: 'dshsd-settings-hint' }, translate('settingsRestartNote')),
          ]),
          data.canSave === false
            ? h('div', { className: 'dshsd-notice', key: 'unavailable' }, translate('settingsUnavailable'))
            : h('div', { className: 'dshsd-settings-body', key: 'body' }, [
              h('div', { className: 'dshsd-field', key: 'days' }, [
                h('label', { className: 'dshsd-field-label', htmlFor: 'dshsd-days', key: 'label' }, translate('settingsRetention')),
                h('div', { className: 'dshsd-field-input', key: 'input' }, [
                  h('input', {
                    key: 'input',
                    id: 'dshsd-days',
                    className: 'dshsd-input',
                    type: 'number',
                    min: 1,
                    max: 365,
                    step: 1,
                    inputMode: 'numeric',
                    value: daysShown,
                    disabled: saving,
                    onChange: (event) => {
                      setDaysDraft(event.target.value)
                      setSaveError(null)
                    },
                  }),
                  h('span', { key: 'unit', className: 'dshsd-field-unit' }, translate('settingsDaysUnit')),
                ]),
              ]),
              h('div', { className: 'dshsd-field', key: 'expiry' }, [
                h('span', { className: 'dshsd-field-label', key: 'label' }, translate('settingsExpiry')),
                h('div', { className: 'dshsd-options', key: 'options', role: 'radiogroup', 'aria-label': translate('settingsExpiry') }, [
                  h('button', {
                    key: 'purge',
                    type: 'button',
                    role: 'radio',
                    'aria-checked': actionShown === 'purge' ? 'true' : 'false',
                    className: 'dshsd-option',
                    disabled: saving,
                    onClick: () => {
                      setActionDraft('purge')
                      setSaveError(null)
                    },
                  }, [
                    h('span', { key: 'title', className: 'dshsd-option-title' }, translate('settingsPurge')),
                    h('span', { key: 'hint', className: 'dshsd-option-hint' }, translate('settingsPurgeHint')),
                  ]),
                  h('button', {
                    key: 'lock',
                    type: 'button',
                    role: 'radio',
                    'aria-checked': actionShown === 'lock' ? 'true' : 'false',
                    className: 'dshsd-option',
                    disabled: saving,
                    onClick: () => {
                      setActionDraft('lock')
                      setSaveError(null)
                    },
                  }, [
                    h('span', { key: 'title', className: 'dshsd-option-title' }, translate('settingsLock')),
                    h('span', { key: 'hint', className: 'dshsd-option-hint' }, translate('settingsLockHint')),
                  ]),
                ]),
              ]),
              h('div', { className: 'dshsd-settings-actions', key: 'actions' }, [
                h('button', {
                  key: 'save',
                  type: 'button',
                  className: 'dshsd-small dshsd-small-primary',
                  disabled: saving || !dirty,
                  onClick: () => { void saveSettings() },
                }, saving ? translate('settingsSaving') : translate('settingsSave')),
                saveError === null
                  ? null
                  : h('span', { key: 'error', className: 'dshsd-settings-error', role: 'alert' }, saveError),
              ]),
            ]),
        ])

      return h('div', { className: 'dshsd-page' },
        h('div', { className: 'dshsd-page-wrap' }, [header, notices.length === 0 ? null : h('div', { key: 'notices', className: 'dshsd-list' }, notices), body, settings]))
    }

    /**
     * Trash glyph for the shared menu row; sized like the host menu icons.
     * @returns one inline SVG.
     */
    function TrashGlyph() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        'aria-hidden': true,
        style: { display: 'block', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
      }, [
        h('path', { key: 'lid', d: 'M4.5 7h15' }),
        h('path', { key: 'handle', d: 'M9.5 7V5.4a1.1 1.1 0 0 1 1.1-1.1h2.8a1.1 1.1 0 0 1 1.1 1.1V7' }),
        h('path', { key: 'body', d: 'M6.6 7l.8 11.1a2.1 2.1 0 0 0 2.1 1.9h5a2.1 2.1 0 0 0 2.1-1.9l.8-11.1' }),
        h('path', { key: 'a', d: 'M10 10.6v5.2' }),
        h('path', { key: 'b', d: 'M14 10.6v5.2' }),
      ])
    }

    /**
     * Sidebar panel icon with a count badge while the bin holds anything.
     * @param props - owner-supplied size and active state.
     * @returns the icon tree.
     */
    function TrashPanelIcon(props) {
      useSharedState()
      useEffect(() => {
        void loadTrash()
      }, [])
      const size = typeof props?.size === 'number' ? props.size : 18
      const active = props?.active === true
      const entries = Array.isArray(trashState.value?.entries) ? trashState.value.entries.length : 0
      return h('span', {
        className: 'dshsd-icon-wrap',
        'data-active': active ? 'true' : 'false',
        title: t('panelLabel'),
      }, [
        h('svg', {
          key: 'svg',
          width: size,
          height: size,
          viewBox: '0 0 36 36',
          'aria-hidden': true,
          style: { display: 'block', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        }, [
          h('path', { key: 'lid', d: 'M8.5 11.5h19' }),
          h('path', { key: 'handle', d: 'M14.5 11.5V9.4a1.3 1.3 0 0 1 1.3-1.3h4.4a1.3 1.3 0 0 1 1.3 1.3v2.1' }),
          h('path', { key: 'body', d: 'M10.8 11.5l1 15.3a2.2 2.2 0 0 0 2.2 2.1h7.9a2.2 2.2 0 0 0 2.2-2.1l1-15.3' }),
          h('path', { key: 'a', d: 'M15 16.5v8.5' }),
          h('path', { key: 'b', d: 'M21 16.5v8.5' }),
        ]),
        entries > 0
          ? h('span', { key: 'badge', className: 'dshsd-icon-badge', 'aria-hidden': true }, entries > 99 ? '99+' : String(entries))
          : null,
      ])
    }

    const inject = ['slots', 'locale', 'contextMenus']

    /**
     * Register styles, dictionaries, the dialog, the trash surfaces, and the
     * Session-row menu contribution.
     * @param context - Client plugin context.
     */
    function apply(context) {
      ctx = context
      try {
        context.effect(() => installStyles(), 'session-delete: dialog and trash styles')
        context.effect(() => context.locale.register(NS, { zh, en }), 'session-delete: dictionaries')
        t = context.locale.bind(NS)

        context.slots.inject('shell.overlay', () => context.slots.register({
          name: 'shell.overlay',
          id: 'session-delete.confirm',
          order: 20,
        }, DeleteConfirmDialog))

        context.slots.inject('contextMenu.icon', () => context.slots.register({
          name: 'contextMenu.icon',
          key: ICON_KEY,
        }, TrashGlyph))

        context.slots.inject('sidebar.panellist', () => context.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_KEY,
          order: 40,
          label: () => t('panelLabel'),
          locale: NS,
        }, TrashPanelIcon))

        context.slots.inject('main', () => context.slots.register({
          name: 'main',
          key: PANEL_KEY,
          locale: NS,
        }, TrashPage))

        context.effect(() => context.contextMenus.register({
          id: 'session.delete',
          target: 'session',
          order: 700,
          resolve: (target) => [{
            id: 'delete',
            label: t('menuLabel'),
            icon: { key: ICON_KEY },
            separatorBefore: true,
            afterContent: true,
            failureLabel: t('failureLabel'),
            run: () => openConfirm({
              sessionId: target.sessionId,
              displayTitle: target.displayTitle,
            }),
          }],
        }), 'session-delete: session menu')
      } catch (error) {
        console.error('[dsh-session-delete] client apply failed:', error)
      }
    }

    return { inject, apply }
  },
})
