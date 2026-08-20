import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, dialog } from "electron";

import { FULL_CAPTURE } from "../common/config";
import { IPC, type RecorderStatus, type StartResult } from "../common/ipc";
import { createCollectors } from "./collectors";
import { installCrashGuards } from "./crash-guards";
import { Describer } from "./describer/describer";
import { processSession } from "./pipeline";
import { registerIpc } from "./ipc";
import { createLogger } from "./logger";
import { NarrationManager } from "./narration/manager";
import { SensitiveModelManager } from "./sensitive/model-manager";
import { RecorderController } from "./recorder/controller";
import { RecordingPrivacySession } from "./recording-privacy";
import { deleteSession } from "./sessions";
import { SkillBuilder } from "./skillbuilder/builder";
import { AutomationBuilder } from "./automationbuilder/builder";
import { createTray } from "./tray";
import { dockIcon } from "./icons";
import { AudioRecorder } from "./audio/recorder";
import { VideoRecorder } from "./video/recorder";
import { ScreenSourceService } from "./video/sources";
import {
  clampRecordingControlsWindow,
  createLibraryWindow,
  createRecorderWindow,
  createRecordingControlsWindow,
  fitRecorderHeight,
  redockLibrary,
  setRecordingControlsExpanded,
} from "./window";
import { exportSessionToPdf } from "./pdfExporter";
import fs from "fs/promises";
import path from "path";

const log = createLogger("Main");

// Contain stray async failures so a lost stream error can't crash the main
// process (and the recording in progress). Registered before any window/IO work.
installCrashGuards(log);

/** Static red-dot tile used for the macOS Dock icon. */
const dock = dockIcon();

let recorderWindow: BrowserWindow | null = null;
let libraryWindow: BrowserWindow | null = null;
let recordingControlsWindow: BrowserWindow | null = null;
let recorderHome: Electron.Rectangle | null = null;
let controlsExpanded = false;
let quitReady = false;
let quitTask: Promise<void> | null = null;
let recordingStartPending = false;
const recordingPrivacy = new RecordingPrivacySession();
const narration = new NarrationManager((status) =>
  broadcast(IPC.narrationStatusChanged, status),
);
const sensitiveModels = new SensitiveModelManager((status) =>
  broadcast(IPC.sensitiveStatusChanged, status),
);
const microphones = new AudioRecorder((status) =>
  broadcast(IPC.microphoneSettingsChanged, status),
);
const screens = new ScreenSourceService((status) =>
  broadcast(IPC.screenSettingsChanged, status),
);
const recorder = new RecorderController({
  resolveConfig: () => ({ ...FULL_CAPTURE }),
  buildCollectors: createCollectors,
  createVideoRecorder: () => new VideoRecorder(),
  createAudioRecorder: (onCaptureEnded) =>
    microphones.createSession(onCaptureEnded),
  deleteSession,
  postProcess: async (dir) => {
    await processSession(dir);
    try {
      await narration.transcribeIfCached(dir);
    } catch (err) {
      log.warn("Cached narration processing failed:", err);
    }
  },
});

async function startRecording(): Promise<StartResult> {
  if (recordingStartPending) {
    return { ok: false, error: "Recording is already starting." };
  }
  recordingStartPending = true;
  try {
    await Promise.all([
      microphones.whenSettingsSettled(),
      screens.whenSettingsSettled(),
    ]);
    const screenOptions = await screens.startOptions();
    return await recorder.start({
      ...microphones.startOptions(),
      ...screenOptions,
    });
  } finally {
    recordingStartPending = false;
  }
}

/** Send an event to every live window (recorder HUD + library, if open). */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

const describer = new Describer((progress) => broadcast(IPC.analyzeProgress, progress));
const builder = new SkillBuilder((progress) => broadcast(IPC.skillProgress, progress));
const automationBuilder = new AutomationBuilder((progress) =>
  broadcast(IPC.automationProgress, progress),
);

/** Open, focus, and re-dock the Sessions library window (creating it lazily). */
function openLibrary(): void {
  if (recorder.state === "recording") return;
  if (!recorderWindow || recorderWindow.isDestroyed()) return;
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    redockLibrary(recorderWindow, libraryWindow);
    libraryWindow.show();
    libraryWindow.focus();
    return;
  }
  recorderHome = recorderWindow.getBounds();
  libraryWindow = createLibraryWindow(recorderWindow);
  libraryWindow.on("closed", () => {
    libraryWindow = null;
    // Return the recorder to where it sat before it made room for the library.
    if (recorderWindow && !recorderWindow.isDestroyed() && recorderHome) {
      recorderWindow.setBounds(recorderHome);
    }
    recorderHome = null;
    // Drop idle agent conversations now that the library is gone.
    void describer.evictIdle();
    void builder.evictIdle();
    void automationBuilder.evictIdle();
  });
}

function ensureRecordingControlsWindow(): BrowserWindow {
  if (recordingControlsWindow && !recordingControlsWindow.isDestroyed()) {
    return recordingControlsWindow;
  }
  controlsExpanded = false;
  recordingControlsWindow = createRecordingControlsWindow();
  recordingControlsWindow.on("closed", () => {
    recordingControlsWindow = null;
    controlsExpanded = false;
  });
  return recordingControlsWindow;
}

function showRecordingControls(): void {
  const win = ensureRecordingControlsWindow();
  clampRecordingControlsWindow(win);
  if (!win.isVisible()) win.showInactive();
  win.moveTop();
}

function showRecorderWindow(): BrowserWindow {
  if (!recorderWindow || recorderWindow.isDestroyed()) {
    recorderWindow = createRecorderWindow();
  }
  recorderWindow.show();
  recorderWindow.focus();
  return recorderWindow;
}

function showRecordingPrivacyWarning(): void {
  const win = showRecorderWindow();
  const notify = () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.recordingPrivacyWarningRequested);
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", notify);
  } else {
    notify();
  }
}

async function requestStartRecording(): Promise<StartResult> {
  if (recordingPrivacy.startDecision() === "start") return startRecording();
  showRecordingPrivacyWarning();
  return { ok: false, privacyWarningRequired: true };
}

/** Keep the full HUD and compact overlay mutually exclusive. */
function syncRecordingWindows(status: RecorderStatus): void {
  if (status.state === "recording") {
    if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.close();
    if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.hide();
    showRecordingControls();
    return;
  }
  // A start emits an idle/starting status before the session folder exists.
  if (status.transition === "starting") return;

  if (recordingControlsWindow && !recordingControlsWindow.isDestroyed()) {
    const controls = recordingControlsWindow;
    if (controlsExpanded) {
      setRecordingControlsExpanded(controls, false);
      controlsExpanded = false;
    }
    controls.hide();
    // Let an overlay-originated stop/discard IPC reply reach its renderer before
    // tearing that renderer down. A recording restarted in the same turn reuses it.
    setTimeout(() => {
      if (
        recorder.state === "idle" &&
        recordingControlsWindow === controls &&
        !controls.isDestroyed()
      ) {
        controls.destroy();
        recordingControlsWindow = null;
      }
    }, 500);
  }
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    const wasHidden = !recorderWindow.isVisible();
    recorderWindow.show();
    if (wasHidden) recorderWindow.focus();
  }
}

function clampControlsToDisplay(): void {
  if (recordingControlsWindow && !recordingControlsWindow.isDestroyed()) {
    clampRecordingControlsWindow(recordingControlsWindow);
  }
}

app.whenReady().then(async () => {
  if (process.platform === "win32") Menu.setApplicationMenu(null);
  if (dock && app.dock) app.dock.setIcon(dock);

  narration.initialize();
  try {
    await microphones.initialize();
  } catch (error) {
    log.warn(
      "Microphone service initialization failed:",
      error instanceof Error ? error.message : error,
    );
  }
  try {
    await screens.initialize();
  } catch (error) {
    log.warn(
      "Screen source initialization failed:",
      error instanceof Error ? error.message : error,
    );
  }
  registerIpc(
    recorder,
    describer,
    builder,
    automationBuilder,
    narration,
    microphones,
    screens,
    sensitiveModels,
    () => recordingStartPending,
  );
  sensitiveModels.initialize();
  ipcMain.handle(IPC.start, () => requestStartRecording());
  ipcMain.handle(IPC.startConfirmed, () => startRecording());
  ipcMain.handle(IPC.recordingPrivacyReviewed, () => recordingPrivacy.markReviewed());
  log.info("Capture: recording all sources");

  ipcMain.handle(IPC.openLibrary, () => openLibrary());
  ipcMain.handle(IPC.closeLibrary, () => {
    if (libraryWindow && !libraryWindow.isDestroyed()) libraryWindow.close();
  });
  ipcMain.handle(IPC.recordingControlsExpanded, (event, expanded: boolean) => {
    const win = recordingControlsWindow;
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      typeof expanded !== "boolean" ||
      recorder.state !== "recording"
    ) {
      return;
    }
    controlsExpanded = expanded;
    setRecordingControlsExpanded(win, expanded);
  });

  // --- ここから追加：Gem用PDFエクスポートの受け口 ---
  ipcMain.handle('EXPORT_PDF_SESSION', async (event, sessionDir: string) => {
    // 1. ユーザーに保存先を選ばせるダイアログを表示
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Gemini用PDFを保存',
      defaultPath: 'session_report.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });

    if (canceled || !filePath) {
      return { success: false, reason: 'canceled' };
    }

    try {
      // 2. 録画されたセッションデータを読み込む（Skill Recorderの仕様に合わせた解析）
      // ※実際には 'frames' フォルダの画像とログを結合します
      const timelinePath = path.join(sessionDir, 'timeline.json'); // ログファイルのパス
      const timelineRaw = await fs.readFile(timelinePath, 'utf-8');
      const timelineData = JSON.parse(timelineRaw);

      // 3. pdfExporter用のデータ形式に変換
      const sessionData = {
        title: 'デスクトップ操作記録',
        createdAt: new Date().toLocaleString('ja-JP'),
        steps: timelineData.map((item: any, index: number) => ({
          action: item.action || '操作ステップ',
          timestamp: new Date(item.timestamp).toLocaleTimeString('ja-JP'),
          description: item.description || '',
          // 該当フレーム画像があればパスを指定
          imagePath: item.frameId ? path.join(sessionDir, 'frames', `${item.frameId}.jpeg`) : undefined
        }))
      };

      // 4. PDF生成を実行
      await exportSessionToPdf(sessionData, filePath);
      
      return { success: true, filePath };
    } catch (error) {
      log.warn("PDF Export Error:", error);
      return { success: false, error: String(error) };
    }
  });
  // --- 追加ここまで ---
  
  ipcMain.on(IPC.fitRecorderHeight, (event, height: unknown) => {
    const win = recorderWindow;
    if (
      !win ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      typeof height !== "number"
    ) {
      return;
    }
    fitRecorderHeight(win, height);
  });

  recorder.onStatusChanged((status) => {
    broadcast(IPC.statusChanged, status);
    syncRecordingWindows(status);
  });
  recorderWindow = createRecorderWindow();

  const handleDisplayChange = () => {
    clampControlsToDisplay();
    void screens.refresh();
  };
  screen.on("display-added", handleDisplayChange);
  screen.on("display-removed", handleDisplayChange);
  screen.on("display-metrics-changed", handleDisplayChange);

  try {
    createTray(
      recorder,
      requestStartRecording,
      showRecorderWindow,
      showRecordingControls,
    );
  } catch (err) {
    log.warn("Tray unavailable:", err);
  }

  const toggle = () => {
    const status = recorder.status();
    if (status.transition !== "none") return;
    void (status.state === "recording" ? recorder.stop() : requestStartRecording());
  };
  if (!globalShortcut.register("CommandOrControl+Shift+R", toggle)) {
    log.warn("Global shortcut registration failed");
  }

  app.on("activate", () => {
    if (recorder.state === "recording") {
      showRecordingControls();
      return;
    }
    showRecorderWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (quitTask) return;
  recorder.beginShutdown();
  quitTask = (async () => {
    // stop() is serialized behind any start/mic/discard operation already in
    // flight, and is a harmless "Not recording" result when the app is idle.
    await recorder.stop();
    await recorder.whenProcessed();
  })()
    .catch((error) => {
      log.warn("graceful shutdown failed:", error);
    })
    .finally(() => {
      quitReady = true;
      app.quit();
    });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  void describer.dispose();
  void builder.dispose();
  void automationBuilder.dispose();
  microphones.dispose();
  void sensitiveModels.dispose();
});
