#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <wchar.h>

#define WM_TRAYICON (WM_USER + 1)
#define IDM_OPEN    1001
#define IDM_EXIT    1002
#define IDM_RESTART 1003

HANDLE hBackendProcess = NULL;
NOTIFYICONDATA nid;
int g_serverPort  = 0;
BOOL g_restarting = FALSE;
volatile BOOL g_quit = FALSE;   /**
 * Open the default web browser to the local server address based on g_serverPort.
 *
 * If g_serverPort is greater than zero, constructs "http://localhost:<port>" and launches it
 * using the system's default handler.
 */

void OpenBrowser() {
    if (g_serverPort > 0) {
        wchar_t url[256];
        swprintf(url, 256, L"http://localhost:%d", g_serverPort);
        ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOW);
    }
}

/**
 * Open the FluxNote runtime log file with the system's associated application.
 *
 * Opens "fluxnote_runtime.log" from the launcher's working directory using the user's default file association.
 */
void OpenLogFile() {
    ShellExecuteW(NULL, L"open", L"fluxnote_runtime.log", NULL, NULL, SW_SHOW);
}

/**
 * Update the system tray icon tooltip text.
 *
 * Sets the tray icon's tooltip to the provided wide-character string. If the
 * text is longer than 127 characters it will be truncated.
 *
 * @param tip Wide-character null-terminated string to display as the tooltip.
 */
void UpdateTip(const wchar_t *tip) {
    wcsncpy(nid.szTip, tip, 127);
    nid.szTip[127] = L'\0';
    nid.uFlags = NIF_TIP;
    Shell_NotifyIconW(NIM_MODIFY, &nid);
    nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
}

/**
 * Display a balloon notification from the tray icon.
 *
 * Sets the tray icon's info title and message and shows a balloon with the specified icon type.
 *
 * @param title UTF-16 null-terminated string used as the balloon title (truncated to 63 characters).
 * @param msg UTF-16 null-terminated string used as the balloon message (truncated to 255 characters).
 * @param flags Notification icon type flags such as NIIF_INFO, NIIF_WARNING, or NIIF_ERROR.
 */
void ShowBalloon(const wchar_t *title, const wchar_t *msg, DWORD flags) {
    wcsncpy(nid.szInfoTitle, title, 63);
    nid.szInfoTitle[63] = L'\0';
    wcsncpy(nid.szInfo, msg, 255);
    nid.szInfo[255] = L'\0';
    nid.dwInfoFlags = flags;
    nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_INFO;
    Shell_NotifyIconW(NIM_MODIFY, &nid);
    nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
}

/**
 * Window procedure for the tray application's hidden window; handles tray interactions,
 * menu commands, and cleanup messages.
 *
 * Handles:
 * - WM_TRAYICON: on right-click shows a popup menu with service status, "Open FluxNote",
 *   "Restart Service", and "Exit" entries (enabling/disabling items based on g_serverPort
 *   and g_restarting); on double-click opens the browser to the server.
 * - WM_COMMAND: dispatches menu actions: opens browser, starts a restart thread if needed,
 *   or sets the quit flag, terminates the backend process, removes the port file and tray
 *   icon, and posts a quit message for exit.
 * - WM_DESTROY: sets the quit flag, removes the tray icon, and posts a quit message.
 *
 * Side effects: may set g_quit, terminate and close the backend process handle,
 * remove the ".port" file, create a background restart thread, remove the tray icon,
 * and post WM_QUIT via PostQuitMessage.
 *
 * @param hwnd Handle to the window receiving the message.
 * @param uMsg Message identifier.
 * @param wParam Additional message information (varies by message).
 * @param lParam Additional message information (varies by message).
 * @returns 0 if the message was handled; otherwise the value returned by DefWindowProcW.
 */
LRESULT CALLBACK WindowProc(HWND hwnd, UINT uMsg, WPARAM wParam, LPARAM lParam) {
    switch (uMsg) {
        case WM_TRAYICON:
            if (lParam == WM_RBUTTONUP) {
                POINT pt;
                GetCursorPos(&pt);
                HMENU hMenu = CreatePopupMenu();

                wchar_t portInfo[64];
                if (g_restarting) {
                    wcscpy(portInfo, L"正在重启服务...");
                } else if (g_serverPort > 0) {
                    swprintf(portInfo, 64, L"运行端口: %d", g_serverPort);
                } else {
                    wcscpy(portInfo, L"正在启动...");
                }
                InsertMenuW(hMenu, -1, MF_BYPOSITION | MF_STRING | MF_GRAYED, 0, portInfo);
                InsertMenuW(hMenu, -1, MF_BYPOSITION | MF_SEPARATOR, 0, NULL);

                UINT openFlags = MF_BYPOSITION | MF_STRING | (g_serverPort > 0 && !g_restarting ? 0 : MF_GRAYED);
                InsertMenuW(hMenu, -1, openFlags, IDM_OPEN, L"打开 FluxNote");
                InsertMenuW(hMenu, -1, MF_BYPOSITION | MF_SEPARATOR, 0, NULL);

                UINT restartFlags = MF_BYPOSITION | MF_STRING | (g_restarting ? MF_GRAYED : 0);
                InsertMenuW(hMenu, -1, restartFlags, IDM_RESTART, L"重启服务");
                InsertMenuW(hMenu, -1, MF_BYPOSITION | MF_SEPARATOR, 0, NULL);
                InsertMenuW(hMenu, -1, MF_BYPOSITION | MF_STRING, IDM_EXIT, L"退出程序");

                SetForegroundWindow(hwnd);
                TrackPopupMenu(hMenu, TPM_BOTTOMALIGN | TPM_LEFTALIGN, pt.x, pt.y, 0, hwnd, NULL);
                DestroyMenu(hMenu);
            } else if (lParam == WM_LBUTTONDBLCLK) {
                OpenBrowser();
            }
            break;

        case WM_COMMAND:
            if (LOWORD(wParam) == IDM_OPEN) {
                OpenBrowser();
            } else if (LOWORD(wParam) == IDM_RESTART) {
                if (!g_restarting) {
                    extern DWORD WINAPI RestartThread(LPVOID);
                    HANDLE hThread = CreateThread(NULL, 0, RestartThread, NULL, 0, NULL);
                    if (hThread) CloseHandle(hThread);
                }
            } else if (LOWORD(wParam) == IDM_EXIT) {
                g_quit = TRUE;          // 先设标志，让等待循环得知是主动退出
                if (hBackendProcess) {
                    TerminateProcess(hBackendProcess, 0);
                    CloseHandle(hBackendProcess);
                    hBackendProcess = NULL; // 置 NULL，防止循环误判为崩溃
                }
                remove(".port");
                Shell_NotifyIconW(NIM_DELETE, &nid);
                PostQuitMessage(0);
            }
            break;

        case WM_DESTROY:
            g_quit = TRUE;
            Shell_NotifyIconW(NIM_DELETE, &nid);
            PostQuitMessage(0);
            break;

        default:
            return DefWindowProcW(hwnd, uMsg, wParam, lParam);
    }
    return 0;
}

/**
 * Restart the backend service: terminate any running core, launch a new core process, wait for it to publish a port, and update the tray UI.
 *
 * This function sets the global restarting flag, updates the tray tooltip and balloons to reflect progress or errors, removes the existing port file, attempts to start the core process, polls for a valid port written to ".port", and on success updates the tooltip and opens the browser. On failure it shows an error balloon and opens the runtime log. If the application quit flag is set while waiting, the restart aborts and the thread exits.
 *
 * @param lpParam Ignored; not used.
 * @returns `0` on successful restart and server readiness, `1` on failure to start or if the server did not become ready within the timeout.
 */
DWORD WINAPI RestartThread(LPVOID lpParam) {
    g_restarting = TRUE;
    UpdateTip(L"FluxNote 正在重启...");
    ShowBalloon(L"FluxNote 正在重启", L"服务重启中，请稍候...", NIIF_INFO);

    if (hBackendProcess) {
        TerminateProcess(hBackendProcess, 0);
        WaitForSingleObject(hBackendProcess, 5000);
        CloseHandle(hBackendProcess);
        hBackendProcess = NULL;
    }

    remove(".port");
    g_serverPort = 0;

    STARTUPINFOW si = { sizeof(STARTUPINFOW) };
    PROCESS_INFORMATION pi;
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;

    wchar_t cmd[] = L"runtime\\FluxNoteCore.exe server.py";

    if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        ShowBalloon(L"FluxNote 重启失败", L"无法启动核心进程，即将打开日志...", NIIF_ERROR);
        UpdateTip(L"FluxNote 重启失败");
        Sleep(2000);
        OpenLogFile();
        g_restarting = FALSE;
        return 1;
    }

    hBackendProcess = pi.hProcess;
    CloseHandle(pi.hThread);

    int max_retries = 1500;
    BOOL server_started = FALSE;
    DWORD startTick = GetTickCount();

    for (int i = 0; i < max_retries; i++) {
        if (g_quit) { g_restarting = FALSE; return 0; }  // 主线程已退出，立即跟随

        if (hBackendProcess && WaitForSingleObject(hBackendProcess, 0) == WAIT_OBJECT_0) {
            ShowBalloon(L"FluxNote 重启失败", L"Python 核心意外崩溃，即将打开日志...", NIIF_ERROR);
            UpdateTip(L"FluxNote 重启失败");
            Sleep(2000);
            OpenLogFile();
            g_restarting = FALSE;
            return 1;
        }

        FILE *fp = fopen(".port", "r");
        if (fp) {
            int port = 0;
            if (fscanf(fp, "%d", &port) == 1 && port > 0) {
                g_serverPort = port;
                server_started = TRUE;
                fclose(fp);
                break;
            }
            fclose(fp);
        }

        if (i % 10 == 0) {
            DWORD elapsed = (GetTickCount() - startTick) / 1000;
            wchar_t tip[128];
            swprintf(tip, 128, L"FluxNote 正在重启... (%ds)", (int)elapsed);
            UpdateTip(tip);
        }

        Sleep(100);
    }

    if (!server_started) {
        ShowBalloon(L"FluxNote 重启超时", L"服务未能在预期时间内启动，即将打开日志...", NIIF_ERROR);
        UpdateTip(L"FluxNote 重启超时");
        Sleep(2000);
        OpenLogFile();
        g_restarting = FALSE;
        return 1;
    }

    wchar_t tip[128];
    swprintf(tip, 128, L"FluxNote 运行于端口 %d", g_serverPort);
    UpdateTip(tip);
    ShowBalloon(L"FluxNote 重启完成", L"服务已恢复，正在打开浏览器...", NIIF_INFO);
    OpenBrowser();
    g_restarting = FALSE;
    return 0;
}

/**
 * Initialize the tray launcher, start and monitor the backend service, and run the Windows message loop.
 *
 * Creates a single-instance mutex, installs a hidden tray window and icon, launches the backend (FluxNoteCore.exe server.py),
 * waits for the backend to publish its port (via the ".port" file) while keeping the tray responsive, shows status balloons,
 * opens the default browser to the server when ready, and dispatches GUI messages until exit.
 *
 * @returns 0 when the launcher exits normally (including when another instance handled opening the browser);
 *          1 on startup or backend failures (failed to launch core, core crashed during startup, or server readiness timeout).
 */
int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nCmdShow) {
    HANDLE hMutex = CreateMutexW(NULL, TRUE, L"FluxNote_Single_Instance_Mutex");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        FILE *fp = fopen(".port", "r");
        if (fp) {
            fscanf(fp, "%d", &g_serverPort);
            fclose(fp);
            OpenBrowser();
        }
        CloseHandle(hMutex);
        return 0;
    }

    remove(".port");

    // ── 1. 立刻创建窗口和托盘图标，给用户即时反馈 ──────────────────────
    WNDCLASSW wc = {0};
    wc.lpfnWndProc   = WindowProc;
    wc.hInstance     = hInstance;
    wc.lpszClassName = L"FluxNoteTrayClass";
    RegisterClassW(&wc);

    HWND hwnd = CreateWindowW(L"FluxNoteTrayClass", L"FluxNote",
        0, 0, 0, 0, 0, NULL, NULL, hInstance, NULL);

    nid.cbSize           = sizeof(NOTIFYICONDATA);
    nid.hWnd             = hwnd;
    nid.uID              = 1;
    nid.uFlags           = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    nid.uCallbackMessage = WM_TRAYICON;
    nid.hIcon            = LoadIcon(hInstance, MAKEINTRESOURCE(1));
    wcscpy(nid.szTip, L"FluxNote 正在启动...");
    Shell_NotifyIconW(NIM_ADD, &nid);

    // 气泡提示用户耐心等待
    ShowBalloon(L"FluxNote 正在启动", L"首次启动约需 10 秒，请稍候...", NIIF_INFO);

    // ── 2. 启动后端进程 ──────────────────────────────────────────────────
    STARTUPINFOW si = { sizeof(STARTUPINFOW) };
    PROCESS_INFORMATION pi;
    si.dwFlags    = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;

    wchar_t cmd[] = L"runtime\\FluxNoteCore.exe server.py";

    if (CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        hBackendProcess = pi.hProcess;
        CloseHandle(pi.hThread);
    } else {
        ShowBalloon(L"FluxNote 启动失败", L"找不到核心程序 FluxNoteCore.exe", NIIF_ERROR);
        UpdateTip(L"FluxNote 启动失败");
        Sleep(3000);
        Shell_NotifyIconW(NIM_DELETE, &nid);
        CloseHandle(hMutex);
        return 1;
    }

    // ── 3. 等待服务就绪，期间保持托盘响应并显示进度 ─────────────────────
    int max_retries = 3000;
    BOOL server_started = FALSE;
    DWORD startTick = GetTickCount();

    for (int i = 0; i < max_retries; i++) {
        // 非阻塞消息处理，让托盘图标保持可点击
        // 必须检测 WM_QUIT：PeekMessage 取出它后 DispatchMessage 不会处理，
        // 若不主动检测，循环将永远感知不到用户的退出操作。
        MSG msg;
        BOOL got_quit = FALSE;
        while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) { got_quit = TRUE; break; }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if (got_quit || g_quit) break;  // 用户主动退出，立即离开等待循环

        // hBackendProcess 为 NULL 说明是 IDM_EXIT 主动关闭的，不视为崩溃
        if (hBackendProcess && WaitForSingleObject(hBackendProcess, 0) == WAIT_OBJECT_0) {
            ShowBalloon(L"FluxNote 启动失败", L"Python 核心意外崩溃，即将打开日志...", NIIF_ERROR);
            UpdateTip(L"FluxNote 启动失败");
            Sleep(2000);
            Shell_NotifyIconW(NIM_DELETE, &nid);
            OpenLogFile();
            CloseHandle(hMutex);
            return 1;
        }

        FILE *fp = fopen(".port", "r");
        if (fp) {
            if (fscanf(fp, "%d", &g_serverPort) == 1 && g_serverPort > 0) {
                server_started = TRUE;
                fclose(fp);
                break;
            }
            fclose(fp);
        }

        // 每秒更新一次 Tooltip，显示已等待秒数
        if (i % 10 == 0) {
            DWORD elapsed = (GetTickCount() - startTick) / 1000;
            wchar_t tip[128];
            swprintf(tip, 128, L"FluxNote 正在启动... (%ds)", (int)elapsed);
            UpdateTip(tip);
        }

        Sleep(100);
    }

    // 用户在启动期间主动退出——IDM_EXIT 已做完所有清理，直接结束
    if (g_quit) {
        if (hMutex) { ReleaseMutex(hMutex); CloseHandle(hMutex); }
        return 0;
    }

    if (!server_started) {
        ShowBalloon(L"FluxNote 启动超时", L"服务未能就绪，即将打开日志...", NIIF_ERROR);
        UpdateTip(L"FluxNote 启动超时");
        Sleep(2000);
        Shell_NotifyIconW(NIM_DELETE, &nid);
        OpenLogFile();
        if (hBackendProcess) TerminateProcess(hBackendProcess, 0);
        CloseHandle(hMutex);
        return 1;
    }

    // ── 4. 服务就绪，更新状态并打开浏览器 ───────────────────────────────
    wchar_t tip[128];
    swprintf(tip, 128, L"FluxNote 运行于端口 %d", g_serverPort);
    UpdateTip(tip);
    ShowBalloon(L"FluxNote 已就绪！", L"你可以在托盘管理FluxNote的运行状态", NIIF_INFO);

    OpenBrowser();

    // ── 5. 主消息循环 ────────────────────────────────────────────────────
    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (hMutex) {
        ReleaseMutex(hMutex);
        CloseHandle(hMutex);
    }
    return 0;
}
