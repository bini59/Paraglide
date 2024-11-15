// main.js
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, clipboard } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const crypto = require('crypto');

// 설정 파일 경로
const configPath = path.join(os.homedir(), '.ParaglideConfigure.json');

// 설정 저장 함수
async function saveConfig(config) {
  try {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('설정 저장 실패:', error);
  }
}

// 설정 불러오기 함수
async function loadConfig() {
  try {
    const data = await fs.readFile(configPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

// 로그 파일 경로
const logPath = path.join(os.homedir(), '.ParaglideParaLog.json');

// 로그 저장 함수
async function saveLog(log) {
  try {
    const jsonString = JSON.stringify(log, null, 2);
    
    // 저장 전 유효성 검사
    try {
      JSON.parse(jsonString);
    } catch {
      throw new Error('유효하지 않은 JSON 데이터');
    }

    console.log('[로그 저장 시도]', { path: logPath });
    await fs.writeFile(logPath, jsonString);
    console.log('[로그 저장 완료]');
  } catch (error) {
    console.error('로그 저장 실패:', error);
    throw error;
  }
}

// 로그 불러오기 함수
async function loadLog() {
  try {
    console.log('[로그 불러오기 시도]', { path: logPath });
    
    // 파일 존재 여부 확인
    try {
      await fs.access(logPath);
    } catch {
      console.log('[로그 파일 없음] 새 로그 파일 생성');
      await saveLog({});
      return {};
    }

    // 파일 읽기 및 검증
    const data = await fs.readFile(logPath, 'utf8');
    if (!data || data.trim().length === 0) {
      console.log('[빈 로그 파일] 초기화');
      await saveLog({});
      return {};
    }

    try {
      const parsedLog = JSON.parse(data);
      console.log('[로그 불러오기 완료]', { entries: Object.keys(parsedLog).length });
      return parsedLog;
    } catch (parseError) {
      console.error('[손상된 로그 파일] 백업 후 초기화');
      
      // 손상된 파일 백업
      const backupPath = `${logPath}.backup.${Date.now()}`;
      await fs.writeFile(backupPath, data);
      
      // 새 로그 파일 생성
      await saveLog({});
      return {};
    }
  } catch (error) {
    console.error('[로그 불러오기 실패]:', error);
    return {};
  }
}

// 파일 해시 계산 함수
function getFileHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

let mainWindow;
let overlayWindow;

// 로고 이미지 경로 설정 수정
const logoConfig = {
  light: path.join(__dirname, 'public', 'logo-light.png'),
  dark: path.join(__dirname, 'public', 'logo-dark.png')
};

// 전역 상태 관리
let globalState = {
  paragraphs: [],
  currentParagraph: 0,
  currentNumber: null,
  isDarkMode: nativeTheme.shouldUseDarkColors,
  paragraphsMetadata: [],
  isPaused: false,
  isOverlayVisible: false,
  timestamp: Date.now(),
  visibleRanges: {
    overlay: {
      before: 1,
      after: 1
    }
  }
};

// 디바운스 함수 추가
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// 단락 접근 함수
const getParagraphByOffset = (baseParagraph, offset = 1) => {
  const targetParagraph = baseParagraph + offset;
  
  if (targetParagraph >= 0 && targetParagraph < globalState.paragraphs.length) {
    return {
      text: globalState.paragraphs[targetParagraph],
      metadata: globalState.paragraphsMetadata[targetParagraph],
      distanceFromCurrent: offset
    };
  }
  return null;
};

// 클립보드 복사 및 로그 저장을 위한 디바운스 함수
const debounceSaveAndCopy = debounce(async () => {
  await saveCurrentPositionToLog();

  const currentParagraphContent = globalState.paragraphs[globalState.currentParagraph];
  if (currentParagraphContent) {
    clipboard.writeText(currentParagraphContent);
  }
}, 500);

// 로그 저장 함수 수정 (예외 처리 포함)
async function saveCurrentPositionToLog() {
  try {
    const log = await loadLog();
    const currentFilePath = globalState.currentFilePath;
    
    if (!currentFilePath) {
      console.error('현재 파일 경로가 없음');
      return;
    }

    const fileHash = getFileHash(globalState.paragraphs.join('\n\n'));
    
    // 로그 데이터 구조 확인
    console.log('[로그 저장]', {
      filePath: currentFilePath,
      currentParagraph: globalState.currentParagraph,
      fileHash: fileHash
    });

    log[currentFilePath] = {
      fileHash,
      filePath: currentFilePath,
      currentParagraph: globalState.currentParagraph,
      lastAccessed: Date.now()
    };

    await saveLog(log);
  } catch (error) {
    console.error('로그 저장 중 에러 발생:', error);
  }
}

// 오버레이 업데이트를 별도 함수로 분리 (예외 처리 포함)
async function updateOverlayContent() {
  try {
    if (!overlayWindow) return;
    
    console.log('[오버레이 업데이트]', {
      current: globalState.currentParagraph,
      pageNumber: globalState.currentNumber
    });

    const { paragraphs, currentParagraph, visibleRanges } = globalState;
    const { before, after } = visibleRanges.overlay;

    const prevParagraphs = [];
    const nextParagraphs = [];

    for (let i = 1; i <= before; i++) {
      const prev = getParagraphByOffset(currentParagraph, -i);
      if (prev) prevParagraphs.unshift(prev);  // 순서 유지를 위해 unshift 사용
    }

    for (let i = 1; i <= after; i++) {
      const next = getParagraphByOffset(currentParagraph, i);
      if (next) nextParagraphs.push(next);
    }

    await overlayWindow.webContents.send('paragraphs-updated', {
      previous: prevParagraphs,
      current: paragraphs[currentParagraph],
      next: nextParagraphs,
      currentNumber: globalState.currentNumber,
      isDarkMode: globalState.isDarkMode,
      isPaused: globalState.isPaused
    });
  } catch (error) {
    console.error('오버레이 업데이트 중 에러 발생:', error);
  }
}

// 상태 업데이트 함수 최적화
const updateGlobalState = (() => {
  let updatePromise = Promise.resolve();

  return async (newState, source = 'other') => {
    updatePromise = updatePromise.then(async () => {
      try {
        const prevState = { ...globalState };
        
        // 순차적 상태 업데이트
        if ('paragraphs' in newState) {
          globalState.paragraphs = newState.paragraphs;
          globalState.paragraphsMetadata = newState.paragraphsMetadata;
        }

        if ('currentParagraph' in newState) {
          globalState.currentParagraph = newState.currentParagraph;
          const metadata = globalState.paragraphsMetadata[globalState.currentParagraph];
          if (metadata) {
            globalState.currentNumber = metadata.pageNumber;
          }
        }

        // 나머지 상태 업데이트
        globalState = { ...globalState, ...newState };

        // 상태 변경 시 필요한 작업 수행
        if ('currentParagraph' in newState && prevState.currentParagraph !== globalState.currentParagraph) {
          await saveCurrentPositionToLog();
          
          const currentParagraphContent = globalState.paragraphs[globalState.currentParagraph];
          if (currentParagraphContent) {
            clipboard.writeText(currentParagraphContent);
          }
        }

        // 오버레이 상태 동기화
        if ('isOverlayVisible' in newState) {
          if (globalState.isOverlayVisible && overlayWindow) {
            overlayWindow.show();
            await updateOverlayContent();
          } else if (overlayWindow) {
            overlayWindow.hide();
          }
        }

        // 창 업데이트
        if (JSON.stringify(prevState) !== JSON.stringify(globalState)) {
          mainWindow?.webContents.send('state-update', globalState);
          
          if (globalState.isOverlayVisible && overlayWindow) {
            await updateOverlayContent();
          }
        }

      } catch (error) {
        console.error('상태 업데이트 중 에러:', error);
      }
    });

    return updatePromise;
  };
})();

// 프로그램 종료 로직을 담당하는 함수
async function handleExitProgram() {
  if (mainWindow) mainWindow.hide();
  if (overlayWindow) overlayWindow.hide();

  try {
    await saveCurrentPositionToLog();
    await saveLog(globalState);
    await saveConfig(globalState);
  } catch (error) {
    console.error('종료 시 백엔드 작업 중 에러 발생:', error);
  } finally {
    app.quit();
  }
}

// 앱 초기화 및 윈도우 생성
function createMainWindow() {
  const minWidth = 600;
  const minHeight = 660;
  const maxWidth = 1300;
  const maxHeight = 900;

  globalState.isDarkMode = nativeTheme.shouldUseDarkColors;

  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, 'public/icons/win/icon.ico')
    : process.platform === 'darwin'
      ? path.join(__dirname, 'public/icons/mac/icon.icns')
      : path.join(__dirname, 'public/icons/png/512x512.png');

  mainWindow = new BrowserWindow({
    width: minWidth,
    height: minHeight,
    minWidth,
    minHeight,
    maxWidth,
    maxHeight,
    show: false,
    title: 'Paraglide',
    icon: iconPath,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadURL('http://localhost:3000');

  mainWindow.once('ready-to-show', () => {
    mainWindow.webContents.send('theme-changed', globalState.isDarkMode);
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (overlayWindow) {
      overlayWindow.close();
      overlayWindow = null;
    }
    handleExitProgram();
  });

  mainWindow.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors);
}

// 오버레이 창 생성 함수
function createOverlayWindow() {
  const minHeight = 240;
  const minWidth = 400;
  const maxHeight = 600;
  const maxWidth = 400;

  overlayWindow = new BrowserWindow({
    width: globalState.overlayBounds?.width || minWidth,
    height: globalState.overlayBounds?.height || minHeight,
    x: globalState.overlayBounds?.x,
    y: globalState.overlayBounds?.y,
    minHeight,
    minWidth,
    maxHeight,
    maxWidth,
    frame: false,
    transparent: true,
    focusable: false,
    alwaysOnTop: true,
    resizable: true,
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false, // 초기에는 숨김 상태
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  overlayWindow.loadURL('http://localhost:3000/overlay');

  overlayWindow.once('ready-to-show', () => {
    overlayWindow.webContents.send('theme-changed', globalState.isDarkMode);
    if (globalState.isOverlayVisible) {
      overlayWindow.show();
    }
  });

  const saveOverlayBounds = () => {
    globalState.overlayBounds = overlayWindow.getBounds();
    saveConfig({ overlayBounds: globalState.overlayBounds });
  };

  overlayWindow.on('move', saveOverlayBounds);
  overlayWindow.on('resize', saveOverlayBounds);

  // 오버레이 창 이벤트 핸들러 추가
  overlayWindow.on('focus', () => {
    if (mainWindow) {
      mainWindow.focus();
    }
  });
}

// IPC 핸들러 설정
function setupIpcHandlers() {
  ipcMain.handle('get-state', () => globalState);
  
  ipcMain.on('update-state', (event, newState) => {
    updateGlobalState(newState);
  });

  // get-logo-path 이벤트 핸들러 수정
  ipcMain.handle('get-logo-path', async () => {
    try {
      const logoPath = nativeTheme.shouldUseDarkColors ? logoConfig.dark : logoConfig.light;
      const imageBuffer = await fs.readFile(logoPath);
      return `data:image/png;base64,${imageBuffer.toString('base64')}`;
    } catch (error) {
      console.error('로고 로드 실패:', error);
      return null;
    }
  });
  
  ipcMain.on('return-to-welcome', () => {
    if (mainWindow) {
      mainWindow.webContents.send('show-welcome-screen');
    }
  });

  ipcMain.on('toggle-overlay', () => {
    if (overlayWindow) {
      globalState.isOverlayVisible = !globalState.isOverlayVisible;
      if (globalState.isOverlayVisible) {
        overlayWindow.show();
        mainWindow.focus();  // 메인 창에 포커스 유지
      } else {
        overlayWindow.hide();
      }
      updateGlobalState({ isOverlayVisible: globalState.isOverlayVisible });
    }
  });

  ipcMain.on('toggle-pause', () => {
    globalState.isPaused = !globalState.isPaused;
    console.log(`[상태 변경] 프로그램 ${globalState.isPaused ? '일시정지' : '재개'}`);
    updateGlobalState({ isPaused: globalState.isPaused });
  });

  ipcMain.on('move-to-next', () => {
    if (globalState.currentParagraph < globalState.paragraphs.length - 1) {
      updateGlobalState({ 
        currentParagraph: globalState.currentParagraph + 1,
        timestamp: Date.now()
      }, 'move');
    }
  });

  ipcMain.on('move-to-prev', () => {
    if (globalState.currentParagraph > 0) {
      updateGlobalState({ 
        currentParagraph: globalState.currentParagraph - 1,
        timestamp: Date.now()
      }, 'move');
    }
  });

  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    });
    return !result.canceled && result.filePaths.length > 0 ? result.filePaths[0] : null;
  });

  ipcMain.handle('read-file', async (event, filePath) => {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return content.replace(/\r\n/g, '\n');
    } catch (error) {
      console.error('Error reading file:', error);
      return null;
    }
  });

  ipcMain.on('update-overlay', (event, content) => {
    if (overlayWindow && content) {
      overlayWindow.webContents.send('paragraphs-updated', {
        previous: content.prev || [],
        current: content.current || null,
        next: content.next || []
      });
    }
  });

  ipcMain.on('resize-overlay', (event, data) => {
    if (!overlayWindow) return;
    const [posX, posY] = overlayWindow.getPosition();
    if (data.edge === 'se') {
      overlayWindow.setSize(
        Math.max(200, parseInt(data.x) - posX),
        Math.max(200, parseInt(data.y) - posY)
      );
    }
  });

  ipcMain.handle('process-file-content', async (event, fileContent, filePath) => {
    try {
      if (!fileContent || !filePath) return { success: false };

      const fileHash = getFileHash(fileContent);
      const log = await loadLog() || {};
      const fileName = path.basename(filePath);
      
      // 로그 복원
      let currentParagraph = 0;
      const previousLogEntry = log[filePath];

      if (previousLogEntry?.fileHash === fileHash) {
        currentParagraph = previousLogEntry.currentParagraph;
      }

      const result = processParagraphs(fileContent);
      if (!result?.paragraphsToDisplay) return { success: false };

      // 유효성 검사
      currentParagraph = Math.min(currentParagraph, result.paragraphsToDisplay.length - 1);

      // 상태 순차 업데이트
      await updateGlobalState({
        paragraphs: result.paragraphsToDisplay,
        paragraphsMetadata: result.paragraphsMetadata,
        currentFilePath: filePath,
        currentParagraph,
        isOverlayVisible: true  // 오버레이 자동 표시
      });

      return { success: true };
    } catch (error) {
      console.error('파일 처리 중 오류:', error);
      return { success: false };
    }
  });

  ipcMain.handle('get-window-position', () => {
    if (!overlayWindow) return { x: 0, y: 0 };
    const [x, y] = overlayWindow.getPosition();
    return { x, y };
  });

  ipcMain.on('exit-program', async () => {
    await handleExitProgram();
  });

  ipcMain.handle('load-file', async () => {
    try {
      const filePath = await ipcMain.handle('open-file-dialog');
      if (!filePath) return { success: false };

      const content = await ipcMain.handle('read-file', null, filePath);
      if (!content) return { success: false };

      return await ipcMain.handle('process-file-content', null, content, filePath);
    } catch (error) {
      console.error('파일 로드 실패:', error);
      return { success: false };
    }
  });
}

// 앱 초기화 시점에서 테마 설정
app.whenReady().then(async () => {
  try {
    globalState.isDarkMode = nativeTheme.shouldUseDarkColors;

    nativeTheme.on('updated', () => {
      globalState.isDarkMode = nativeTheme.shouldUseDarkColors;
      mainWindow?.webContents.send('theme-changed', globalState.isDarkMode);
      overlayWindow?.webContents.send('theme-changed', globalState.isDarkMode);
    });

    const savedConfig = await loadConfig();
    if (savedConfig.overlayBounds) {
      globalState.overlayBounds = savedConfig.overlayBounds;
    }

    createMainWindow();
    createOverlayWindow();
    setupIpcHandlers();
    
    mainWindow?.show();
  } catch (error) {
    console.error('Application initialization failed:', error);
  }
});

// 3. 텍스트 처리 유틸리티 함수
const pagePatterns = {
  numberOnly: /^(\d+)$/,               // "127", "128" 등 숫자로만 이루어진 페이지 번호
  koreanStyle: /^(\d+)(페이지|페)$/,   // "127페이지", "127페" 등 한글이 들어간 페이지 번호
  englishStyle: /^(\d+)(page|p)$/i     // "127page", "127p" 등 영어가 들어간 페이지 번호
};

const skipPatterns = {
  separator: /^[=\-]{3,}/, // === 또� --- 로 시작하는 단락
  comment: /^[\/\/#]/,       // //, # 으로 시작하는 단락
};

const extractPageNumber = (paragraph) => {
  const text = paragraph.trim();
  for (const pattern of Object.values(pagePatterns)) {
    const match = text.match(pattern);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return null;
};

const shouldSkipParagraph = (paragraph) => {
  // 페이지 번호 패턴도 스킵 대상에 포함
  const isPageNumber = Object.values(pagePatterns).some(pattern => 
    pattern.test(paragraph.trim())
  );
  
  return isPageNumber || Object.values(skipPatterns).some(pattern => 
    pattern.test(paragraph.trim())
  );
};

// Main.js의 텍스트 처리 부분 수정
const processParagraphs = (fileContent) => {
  const splitParagraphs = fileContent
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  let currentNumber = null;
  const paragraphsMetadata = [];
  const paragraphsToDisplay = [];
  let previousWasPageNumber = false;

  splitParagraphs.forEach((p) => {
    const pageNum = extractPageNumber(p);
    
    if (pageNum) {
      currentNumber = pageNum;
      previousWasPageNumber = true;
    } else if (!shouldSkipParagraph(p)) {
      // 실제 내용 단락만 추가
      paragraphsToDisplay.push(p);
      paragraphsMetadata.push({
        isPageChange: previousWasPageNumber,
        pageNumber: currentNumber,
        index: paragraphsToDisplay.length - 1
      });
      previousWasPageNumber = false;
    }
  });

  return {
    paragraphsToDisplay,
    paragraphsMetadata,
    currentNumber: currentNumber || null
  };
};