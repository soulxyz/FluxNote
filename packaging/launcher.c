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
volatile BOOL g_quit = FALSE;   // 用户主动退出标志，供所有循环检测

// 保护 hBackendProcess 和 g_restarting 的跨线程访问
static CRITICAL_SECTION g_cs;

void OpenBrowser() {
    if (g_serverPort > 0) {
        wchar_t url[256];
        swprintf(url, 256, L"http://localhost:%d", g_serverPort);
        ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOW);
    }
}

void OpenLogFile() {
    ShellExecuteW(NULL, L"open", L"fluxnote_runtime.log", NULL, NULL, SW_SHOW);
}

// 只更新托盘 Tooltip 文字
void UpdateTip(const wchar_t *tip) {
    wcsncpy(nid.szTip, tip, 127);
    nid.szTip[127] = L'\0';
    nid.uFlags = NIF_TIP;
    Shell_NotifyIconW(NIM_MODIFY, &nid);
    nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
}

// 弹出气泡通知（flags: NIIF_INFO / NIIF_WARNING / NIIF_ERROR）
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
                // 在 CreateThread 之前，在临界区内原子地检查并设置 g_restarting，
                // 避免两次快速点击之间存在窗口期导致双重启动
                BOOL doStart = FALSE;
                EnterCriticalSection(&g_cs);
                if (!g_restarting) {
                    g_restarting = TRUE;
                    doStart = TRUE;
                }
                LeaveCriticalSection(&g_cs);
                if (doStart) {
                    extern DWORD WINAPI RestartThread(LPVOID);
                    HANDLE hThread = CreateThread(NULL, 0, RestartThread, NULL, 0, NULL);
                    if (hThread) CloseHandle(hThread);
                }
            } else if (LOWORD(wParam) == IDM_EXIT) {
                g_quit = TRUE;          // 先设标志，让等待循环得知是主动退出
                // 在临界区内取走句柄并置 NULL，防止 RestartThread 并发访问
                EnterCriticalSection(&g_cs);
                HANDLE hProc = hBackendProcess;
                hBackendProcess = NULL; // 置 NULL，防止循环误判为崩溃
                LeaveCriticalSection(&g_cs);
                if (hProc) {
                    TerminateProcess(hProc, 0);
                    CloseHandle(hProc);
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

DWORD WINAPI RestartThread(LPVOID lpParam) {
    // g_restarting 已由 IDM_RESTART 处理器在 CreateThread 前设置为 TRUE，此处无需重复设置
    UpdateTip(L"FluxNote 正在重启...");
    ShowBalloon(L"FluxNote 正在重启", L"服务重启中，请稍候...", NIIF_INFO);

    // 在临界区内取走旧进程句柄并置 NULL，防止与 IDM_EXIT 并发 TerminateProcess/CloseHandle
    EnterCriticalSection(&g_cs);
    HANDLE hOld = hBackendProcess;
    hBackendProcess = NULL;
    LeaveCriticalSection(&g_cs);

    if (hOld) {
        TerminateProcess(hOld, 0);
        WaitForSingleObject(hOld, 5000);
        CloseHandle(hOld);
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
        EnterCriticalSection(&g_cs);
        g_restarting = FALSE;
        LeaveCriticalSection(&g_cs);
        return 1;
    }

    // 在临界区内写入新进程句柄
    EnterCriticalSection(&g_cs);
    hBackendProcess = pi.hProcess;
    LeaveCriticalSection(&g_cs);
    CloseHandle(pi.hThread);

    int max_retries = 1500;
    BOOL server_started = FALSE;
    DWORD startTick = GetTickCount();

    for (int i = 0; i < max_retries; i++) {
        if (g_quit) {
            EnterCriticalSection(&g_cs);
            g_restarting = FALSE;
            LeaveCriticalSection(&g_cs);
            return 0;  // 主线程已退出，立即跟随
        }

        // 在临界区内读取句柄的快照，避免与 IDM_EXIT 并发 CloseHandle
        EnterCriticalSection(&g_cs);
        HANDLE hCur = hBackendProcess;
        LeaveCriticalSection(&g_cs);

        if (hCur && WaitForSingleObject(hCur, 0) == WAIT_OBJECT_0) {
            ShowBalloon(L"FluxNote 重启失败", L"Python 核心意外崩溃，即将打开日志...", NIIF_ERROR);
            UpdateTip(L"FluxNote 重启失败");
            Sleep(2000);
            OpenLogFile();
            EnterCriticalSection(&g_cs);
            g_restarting = FALSE;
            LeaveCriticalSection(&g_cs);
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
        EnterCriticalSection(&g_cs);
        g_restarting = FALSE;
        LeaveCriticalSection(&g_cs);
        return 1;
    }

    wchar_t tip[128];
    swprintf(tip, 128, L"FluxNote 运行于端口 %d", g_serverPort);
    UpdateTip(tip);
    ShowBalloon(L"FluxNote 重启完成", L"服务已恢复，正在打开浏览器...", NIIF_INFO);
    OpenBrowser();
    EnterCriticalSection(&g_cs);
    g_restarting = FALSE;
    LeaveCriticalSection(&g_cs);
    return 0;
}

// 判断今天是否已弹过就绪通知；首次返回 TRUE 并记录日期，当天后续返回 FALSE
static BOOL ShouldShowDailyNotify() {
    SYSTEMTIME st;
    GetLocalTime(&st);
    char today[16];
    sprintf(today, "%04d-%02d-%02d", st.wYear, st.wMonth, st.wDay);

    FILE *fp = fopen(".notify_date", "r");
    if (fp) {
        char stored[16] = {0};
        fscanf(fp, "%15s", stored);
        fclose(fp);
        if (strcmp(today, stored) == 0) return FALSE;
    }

    fp = fopen(".notify_date", "w");
    if (fp) { fprintf(fp, "%s", today); fclose(fp); }
    return TRUE;
}

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
    InitializeCriticalSection(&g_cs);

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
        DeleteCriticalSection(&g_cs);
        CloseHandle(hMutex);
        return 1;
    }

    // ── 3. 等待服务就绪，期间保持托盘响应并显示进度 ─────────────────────
    int max_retries = 3000;
    BOOL server_started = FALSE;
    BOOL shownSlowBalloon = FALSE;
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

        // 在临界区内读取句柄快照，防止 RestartThread（由启动期间的菜单触发）并发 CloseHandle
        // hBackendProcess 为 NULL 说明是 IDM_EXIT 主动关闭的，不视为崩溃
        EnterCriticalSection(&g_cs);
        HANDLE hCur = hBackendProcess;
        LeaveCriticalSection(&g_cs);

        if (hCur && WaitForSingleObject(hCur, 0) == WAIT_OBJECT_0) {
            ShowBalloon(L"FluxNote 启动失败", L"Python 核心意外崩溃，即将打开日志...", NIIF_ERROR);
            UpdateTip(L"FluxNote 启动失败");
            Sleep(2000);
            Shell_NotifyIconW(NIM_DELETE, &nid);
            OpenLogFile();
            DeleteCriticalSection(&g_cs);
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

        DWORD elapsed = GetTickCount() - startTick;

        // 超过 3 秒才弹一次"略久"提示，之后不再重复
        if (!shownSlowBalloon && elapsed > 3000) {
            ShowBalloon(L"FluxNote 正在启动",
                        L"启动略久，请稍候...\n可右键托盘图标管理运行状态", NIIF_INFO);
            shownSlowBalloon = TRUE;
        }

        // 每秒更新一次 Tooltip，显示已等待秒数
        if (i % 10 == 0) {
            wchar_t tip[128];
            swprintf(tip, 128, L"FluxNote 正在启动... (%ds)", (int)(elapsed / 1000));
            UpdateTip(tip);
        }

        Sleep(100);
    }

    // 用户在启动期间主动退出——IDM_EXIT 已做完所有清理，直接结束
    if (g_quit) {
        DeleteCriticalSection(&g_cs);
        if (hMutex) { ReleaseMutex(hMutex); CloseHandle(hMutex); }
        return 0;
    }

    if (!server_started) {
        ShowBalloon(L"FluxNote 启动超时", L"服务未能就绪，即将打开日志...", NIIF_ERROR);
        UpdateTip(L"FluxNote 启动超时");
        Sleep(2000);
        Shell_NotifyIconW(NIM_DELETE, &nid);
        OpenLogFile();
        // 在临界区内取走句柄后再 Terminate，防止与可能的 RestartThread 并发
        EnterCriticalSection(&g_cs);
        HANDLE hProc = hBackendProcess;
        hBackendProcess = NULL;
        LeaveCriticalSection(&g_cs);
        if (hProc) TerminateProcess(hProc, 0);
        DeleteCriticalSection(&g_cs);
        CloseHandle(hMutex);
        return 1;
    }

    // ── 4. 服务就绪，更新状态并打开浏览器 ───────────────────────────────
    wchar_t tip[128];
    swprintf(tip, 128, L"FluxNote 运行于端口 %d", g_serverPort);
    UpdateTip(tip);
    // 慢启动已弹过一次提示，不再重复；快速启动仅当天首次弹出就绪通知
    if (!shownSlowBalloon && ShouldShowDailyNotify()) {
        ShowBalloon(L"FluxNote 已就绪", L"双击托盘图标可快速打开", NIIF_INFO);
    }

    OpenBrowser();

    // ── 5. 主消息循环 ────────────────────────────────────────────────────
    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    DeleteCriticalSection(&g_cs);
    if (hMutex) {
        ReleaseMutex(hMutex);
        CloseHandle(hMutex);
    }
    return 0;
}
