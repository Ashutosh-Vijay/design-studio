// VS Code build: the rest of the Tauri API the app uses, each aliased here by vite.config.vscode.ts.
// Dialogs, links and folders go to VS Code's own (through the host); window, zoom and updates belong to
// VS Code itself, so those are quiet no-ops. The Marketplace updates the extension.
import { invoke } from './core';

// @tauri-apps/plugin-dialog
type Filter = { name: string; extensions: string[] };
export const open = (options: { multiple?: boolean; directory?: boolean; filters?: Filter[]; defaultPath?: string; title?: string } = {}) =>
  invoke<string | string[] | null>('vscode_open_dialog', { options });
export const save = (options: { defaultPath?: string; filters?: Filter[]; title?: string } = {}) => invoke<string | null>('vscode_save_dialog', { options });
export const confirm = (message: string, options?: { title?: string; kind?: string; okLabel?: string }) => invoke<boolean>('vscode_confirm', { message, okLabel: options?.okLabel });

// @tauri-apps/plugin-opener
export const openUrl = (url: string) => invoke<void>('vscode_open_url', { url });
export const revealItemInDir = (path: string) => invoke<void>('vscode_reveal', { path });

// @tauri-apps/plugin-updater, @tauri-apps/plugin-process
export type Update = { version: string; downloadAndInstall: (cb?: (e: unknown) => void) => Promise<void> };
export const check = async (): Promise<Update | null> => null;
export const relaunch = async () => {};

// @tauri-apps/api/app
export const getVersion = () => invoke<string>('vscode_version');

// @tauri-apps/api/path
export const homeDir = () => invoke<string>('vscode_dir', { which: 'home' });
export const documentDir = () => invoke<string>('vscode_dir', { which: 'documents' });
export const downloadDir = () => invoke<string>('vscode_dir', { which: 'downloads' });
export const appCacheDir = () => invoke<string>('vscode_dir', { which: 'cache' });
export const appConfigDir = () => invoke<string>('vscode_dir', { which: 'config' });

// @tauri-apps/api/window, @tauri-apps/api/webview
export const getCurrentWindow = () => ({
  show: async () => {}, isMaximized: async () => false, onResized: async () => () => {},
  // A VS Code tab can't refuse to close; unsaved work is journaled every few seconds and offered back.
  onCloseRequested: async () => () => {},
  minimize: () => {}, toggleMaximize: () => {}, close: async () => {}, destroy: async () => {}, setTitle: async () => {},
});
export const getCurrentWebview = () => ({ setZoom: async () => {} });
