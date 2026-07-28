export type Locale = "en" | "ru" | "hy";

export interface MessageCatalog {
  languageSelectorLabel: string;
  brand: {
    name: string;
    welcomeSubtitle: string;
    activeSubtitle: string;
  };
  common: {
    ready: string;
    cancel: string;
    printProgress: string;
    steps: [string, string, string, string];
    privacyNotice: string;
    keepSession: string;
    cancelSession: string;
    cancelTitle: string;
    cancelDescription: string;
    cleanupInProgress: string;
    cleanupInProgressDescription: string;
    cleanupPendingTitle: string;
    cleanupPendingDescription: string;
    retryCleanup: string;
    monochrome: string;
  };
  welcome: {
    eyebrow: string;
    title: string;
    lead: string;
    availableService: string;
    serviceTitle: string;
    serviceDescription: string;
    starting: string;
    start: string;
    startError: string;
    footerSecure: string;
    footerNoAccount: string;
    footerTouchscreen: string;
  };
  upload: {
    step: string;
    title: string;
    description: string;
    instructionCamera: string;
    instructionQr: string;
    instructionFile: string;
    sessionLabel: string;
    qrTitle: string;
    waitingForPhone: string;
    uploadedDocument: string;
    uploadComplete: string;
    placeholder: string;
    continue: string;
    continueUnavailable: string;
    rejectedHelp: string;
    refreshError: string;
    fileName: (position: number, extension: string) => string;
    fileUploading: string;
    fileQuarantined: string;
    fileChecking: string;
    fileRejected: string;
    fileDeleting: string;
    fileDeleted: string;
    rejectionMalware: string;
    rejectionScanner: string;
    rejectionEncrypted: string;
    rejectionInvalid: string;
    rejectionPageLimit: string;
    rejectionLimits: string;
    rejectionTimeout: string;
    rejectionGeneric: string;
    fileMeta: (pageCount: number, size: string) => string;
  };
  configure: {
    step: string;
    title: string;
    description: string;
    remove: string;
    removing: string;
    removeFailed: string;
    previewTitle: string;
    previewLoading: string;
    previewUnavailable: string;
    previewPage: (pageNumber: number) => string;
    settingsTitle: string;
    pages: string;
    allPages: (pageCount: number) => string;
    fromPage: string;
    toPage: string;
    decreaseFromPage: string;
    increaseFromPage: string;
    decreaseToPage: string;
    increaseToPage: string;
    orientation: string;
    portrait: string;
    landscape: string;
    paperSides: string;
    singleSided: string;
    doubleSided: string;
    copies: string;
    copiesAria: string;
    decreaseCopies: string;
    increaseCopies: string;
    summaryTitle: string;
    selectedPages: string;
    printedSides: string;
    paperSheets: string;
    output: string;
    estimatedTotal: string;
    reviewAndPay: string;
    backToUpload: string;
  };
  checkout: {
    step: string;
    title: string;
    description: string;
    selectedPages: (count: number) => string;
    edit: string;
    copies: string;
    sides: string;
    output: string;
    prototypeOutcome: string;
    prototypeDescription: string;
    outcomeSuccess: string;
    outcomePaymentDeclined: string;
    outcomePrinterError: string;
    paymentSummary: string;
    monochromeSides: (count: number) => string;
    minimumTransaction: string;
    applied: string;
    totalDue: string;
    pay: (price: string) => string;
    demoNotice: string;
  };
  status: {
    paymentEyebrow: string;
    paymentTitle: string;
    paymentDescription: string;
    paymentDetail: string;
    printingEyebrow: string;
    printingTitle: string;
    printingDescription: string;
    printingDetail: string;
    actionNeeded: string;
    paymentDeclinedTitle: string;
    printerErrorTitle: string;
    paymentDeclinedDescription: string;
    printerErrorDescription: string;
    paymentDeclinedCode: string;
    printerErrorCode: string;
    failureDetail: string;
    reviewSettings: string;
    retryPayment: string;
    retryPrinting: string;
    completeEyebrow: string;
    completeTitle: string;
    collectSheets: (count: number) => string;
    printed: string;
    paid: string;
    files: string;
    deletionScheduled: string;
    finish: string;
  };
  idle: {
    countdown: (seconds: number) => string;
    timeRemaining: string;
    title: string;
    description: string;
    endSession: string;
    continue: string;
  };
  error: {
    eyebrow: string;
    title: string;
    description: string;
    restart: string;
  };
  units: {
    megabytes: string;
  };
}

export const languageOptions: ReadonlyArray<{
  locale: Locale;
  nativeName: string;
  shortLabel: string;
}> = [
  { locale: "en", nativeName: "English", shortLabel: "ENG" },
  { locale: "ru", nativeName: "Русский", shortLabel: "РУС" },
  { locale: "hy", nativeName: "Հայերեն", shortLabel: "ՀԱՅ" }
];

export const numberLocales: Record<Locale, string> = {
  en: "en-US",
  ru: "ru-RU",
  hy: "hy-AM"
};

const english: MessageCatalog = {
  languageSelectorLabel: "Choose another language",
  brand: {
    name: "Print kiosk",
    welcomeSubtitle: "Private self-service printing",
    activeSubtitle: "Black-and-white documents"
  },
  common: {
    ready: "Ready",
    cancel: "Cancel",
    printProgress: "Print progress",
    steps: ["Upload", "Settings", "Pay", "Print"],
    privacyNotice: "Private files are removed automatically after this session.",
    keepSession: "Keep session",
    cancelSession: "Cancel session",
    cancelTitle: "Cancel this print session?",
    cancelDescription: "No payment will be made. Uploaded files will be removed.",
    cleanupInProgress: "Closing private session…",
    cleanupInProgressDescription:
      "Keep this screen open while the kiosk confirms that file cleanup has started.",
    cleanupPendingTitle: "File cleanup still needs confirmation",
    cleanupPendingDescription:
      "The kiosk could not confirm that this private session was closed. It has kept the session on this screen so you can retry safely. Please do not leave yet.",
    retryCleanup: "Retry secure cleanup",
    monochrome: "Black-and-white"
  },
  welcome: {
    eyebrow: "Fast · private · self-service",
    title: "Print from your phone in a few simple steps.",
    lead: "Scan a QR code, upload your document, choose print settings, and pay at this screen.",
    availableService: "Available service",
    serviceTitle: "Print documents",
    serviceDescription: "Upload from your phone. No account or app required.",
    starting: "Starting…",
    start: "Start printing",
    startError: "Could not start a print session. Please try again.",
    footerSecure: "Secure session",
    footerNoAccount: "No account needed",
    footerTouchscreen: "Touchscreen kiosk"
  },
  upload: {
    step: "Step 1 of 4",
    title: "Upload your document",
    description: "Scan this QR code with your phone. No account or app is needed.",
    instructionCamera: "Open your phone camera",
    instructionQr: "Point the camera at the QR code",
    instructionFile: "Choose a PDF, JPEG, or PNG file",
    sessionLabel: "Upload session",
    qrTitle: "QR code for secure phone upload",
    waitingForPhone: "Waiting for your phone",
    uploadedDocument: "Uploaded document",
    uploadComplete: "Upload complete",
    placeholder: "Your uploaded files will appear here automatically.",
    continue: "Continue to print settings",
    continueUnavailable: "Print settings will unlock after the document passes security checks.",
    rejectedHelp: "Remove this file on your phone and upload another document.",
    refreshError: "The upload status is temporarily unavailable. We will keep trying.",
    fileName: (position, extension) =>
      extension === "file" ? `Document ${position}` : `Document ${position}.${extension}`,
    fileUploading: "Upload in progress",
    fileQuarantined: "Received — waiting for a secure check",
    fileChecking: "Checking safety and preparing page previews",
    fileRejected: "File rejected",
    fileDeleting: "Removing file",
    fileDeleted: "File removed",
    rejectionMalware: "This file did not pass the malware safety scan.",
    rejectionScanner: "The safety scanner is unavailable. Try again in a few minutes.",
    rejectionEncrypted: "Password-protected documents cannot be printed.",
    rejectionInvalid: "This file is damaged or is not a valid PDF or image.",
    rejectionPageLimit: "This document has more pages than we can print.",
    rejectionLimits: "This document exceeds the allowed image size limits.",
    rejectionTimeout: "This document took too long to process safely.",
    rejectionGeneric: "This file could not be prepared safely. Upload another file.",
    fileMeta: (pageCount, size) => `${pageCount} ${pageCount === 1 ? "page" : "pages"} · ${size}`
  },
  configure: {
    step: "Step 2 of 4",
    title: "Choose print settings",
    description: "Review each option before payment. All output is black-and-white.",
    remove: "Remove",
    removing: "Removing…",
    removeFailed: "The file could not be removed. Try again before continuing.",
    previewTitle: "Document preview",
    previewLoading: "Preparing page previews…",
    previewUnavailable: "Page previews are temporarily unavailable. Try again.",
    previewPage: (pageNumber) => `Page ${pageNumber}`,
    settingsTitle: "Document settings",
    pages: "Pages",
    allPages: (pageCount) => `All pages (1–${pageCount})`,
    fromPage: "From page",
    toPage: "To page",
    decreaseFromPage: "Decrease first page",
    increaseFromPage: "Increase first page",
    decreaseToPage: "Decrease last page",
    increaseToPage: "Increase last page",
    orientation: "Orientation",
    portrait: "Portrait",
    landscape: "Landscape",
    paperSides: "Paper sides",
    singleSided: "Single-sided",
    doubleSided: "Double-sided",
    copies: "Copies",
    copiesAria: "Number of copies",
    decreaseCopies: "Decrease copies",
    increaseCopies: "Increase copies",
    summaryTitle: "Print summary",
    selectedPages: "Selected pages",
    printedSides: "Printed sides",
    paperSheets: "Paper sheets",
    output: "Output",
    estimatedTotal: "Estimated total",
    reviewAndPay: "Review and pay",
    backToUpload: "Back to upload"
  },
  checkout: {
    step: "Step 3 of 4",
    title: "Review and pay",
    description: "Check your print details. The prototype will simulate payment at this kiosk.",
    selectedPages: (count) => `${count} selected ${count === 1 ? "page" : "pages"}`,
    edit: "Edit",
    copies: "Copies",
    sides: "Sides",
    output: "Output",
    prototypeOutcome: "Prototype outcome",
    prototypeDescription: "Choose a result to verify the kiosk recovery screens.",
    outcomeSuccess: "Successful print",
    outcomePaymentDeclined: "Payment declined",
    outcomePrinterError: "Printer error",
    paymentSummary: "Payment summary",
    monochromeSides: (count) => `${count} black-and-white ${count === 1 ? "side" : "sides"}`,
    minimumTransaction: "Minimum transaction",
    applied: "Applied",
    totalDue: "Total due",
    pay: (price) => `Pay ${price}`,
    demoNotice: "Demo only. No card data or real charge is involved."
  },
  status: {
    paymentEyebrow: "Secure demo payment",
    paymentTitle: "Processing payment",
    paymentDescription: "Please wait. Do not close or leave this screen.",
    paymentDetail: "No real charge is made in this prototype.",
    printingEyebrow: "Step 4 of 4",
    printingTitle: "Printing your document",
    printingDescription: "Your payment was approved. Please wait for every sheet.",
    printingDetail: "Preparing · Sending · Printing",
    actionNeeded: "Action needed",
    paymentDeclinedTitle: "Payment was declined",
    printerErrorTitle: "The printer needs attention",
    paymentDeclinedDescription:
      "Nothing was charged. You can retry the demo payment or return to your settings.",
    printerErrorDescription:
      "Printing stopped before completion. Keep this session open while you retry.",
    paymentDeclinedCode: "PAYMENT DECLINED",
    printerErrorCode: "PRINTER UNAVAILABLE",
    failureDetail: "Prototype failure · Your file is still available in this session.",
    reviewSettings: "Review settings",
    retryPayment: "Retry payment",
    retryPrinting: "Retry printing",
    completeEyebrow: "Print complete",
    completeTitle: "Your documents are ready",
    collectSheets: (count) =>
      `Collect all ${count} ${count === 1 ? "sheet" : "sheets"} from the output area below.`,
    printed: "Printed",
    paid: "Paid",
    files: "Files",
    deletionScheduled: "Deletion scheduled",
    finish: "Finish and delete files"
  },
  idle: {
    countdown: (seconds) => `${seconds} seconds remaining`,
    timeRemaining: "Time remaining",
    title: "Do you need more time?",
    description:
      "For your privacy, this session will close and remove its files when the timer reaches zero.",
    endSession: "End session",
    continue: "Continue printing"
  },
  error: {
    eyebrow: "Kiosk recovery",
    title: "Something went wrong",
    description: "Your documents have not been printed or charged.",
    restart: "Restart kiosk"
  },
  units: { megabytes: "MB" }
};

const russian: MessageCatalog = {
  languageSelectorLabel: "Выберите другой язык",
  brand: {
    name: "Терминал печати",
    welcomeSubtitle: "Безопасная самостоятельная печать",
    activeSubtitle: "Чёрно-белая печать документов"
  },
  common: {
    ready: "Готов",
    cancel: "Отменить",
    printProgress: "Этапы печати",
    steps: ["Загрузка", "Настройки", "Оплата", "Печать"],
    privacyNotice: "Личные файлы автоматически удалятся после завершения сеанса.",
    keepSession: "Продолжить",
    cancelSession: "Отменить сеанс",
    cancelTitle: "Отменить этот сеанс печати?",
    cancelDescription: "Оплата не будет выполнена, а загруженные файлы будут удалены.",
    cleanupInProgress: "Закрываем конфиденциальный сеанс…",
    cleanupInProgressDescription:
      "Не закрывайте этот экран, пока терминал подтверждает начало удаления файлов.",
    cleanupPendingTitle: "Удаление файлов ещё не подтверждено",
    cleanupPendingDescription:
      "Терминал не смог подтвердить, что конфиденциальный сеанс закрыт. Сеанс остался на экране для безопасной повторной попытки. Пока не уходите.",
    retryCleanup: "Повторить безопасное удаление",
    monochrome: "Чёрно-белая"
  },
  welcome: {
    eyebrow: "Быстро · конфиденциально · самостоятельно",
    title: "Печатайте с телефона за несколько простых шагов.",
    lead: "Отсканируйте QR-код, загрузите документ, настройте печать и оплатите заказ на этом экране.",
    availableService: "Доступная услуга",
    serviceTitle: "Печать документов",
    serviceDescription: "Загрузите файлы с телефона — без регистрации и установки приложения.",
    starting: "Создаём сеанс…",
    start: "Начать печать",
    startError: "Не удалось создать сеанс печати. Попробуйте ещё раз.",
    footerSecure: "Защищённый сеанс",
    footerNoAccount: "Без регистрации",
    footerTouchscreen: "Сенсорный терминал"
  },
  upload: {
    step: "Шаг 1 из 4",
    title: "Загрузите документ",
    description: "Отсканируйте QR-код телефоном. Регистрация и приложение не нужны.",
    instructionCamera: "Откройте камеру телефона",
    instructionQr: "Наведите камеру на QR-код",
    instructionFile: "Выберите файл PDF, JPEG или PNG",
    sessionLabel: "Сеанс загрузки",
    qrTitle: "QR-код для безопасной загрузки с телефона",
    waitingForPhone: "Ожидаем подключение телефона",
    uploadedDocument: "Загруженный документ",
    uploadComplete: "Загрузка завершена",
    placeholder: "Загруженные файлы автоматически появятся здесь.",
    continue: "Перейти к настройкам печати",
    continueUnavailable:
      "Настройки печати откроются после того, как документ пройдёт проверку безопасности.",
    rejectedHelp: "Удалите этот файл на телефоне и загрузите другой документ.",
    refreshError: "Статус загрузки временно недоступен. Проверка повторится автоматически.",
    fileName: (position, extension) =>
      extension === "file" ? `Документ ${position}` : `Документ ${position}.${extension}`,
    fileUploading: "Файл загружается",
    fileQuarantined: "Файл получен и ожидает безопасной проверки",
    fileChecking: "Проверяем безопасность и готовим страницы для просмотра",
    fileRejected: "Файл отклонён",
    fileDeleting: "Удаляем файл",
    fileDeleted: "Файл удалён",
    rejectionMalware: "Файл не прошёл проверку на вредоносное содержимое.",
    rejectionScanner: "Проверка безопасности недоступна. Повторите попытку через несколько минут.",
    rejectionEncrypted: "Документы, защищённые паролем, напечатать нельзя.",
    rejectionInvalid: "Файл повреждён или не является корректным PDF-файлом либо изображением.",
    rejectionPageLimit: "В документе больше страниц, чем можно напечатать.",
    rejectionLimits: "Документ превышает допустимый размер изображения.",
    rejectionTimeout: "Не удалось безопасно обработать документ за отведённое время.",
    rejectionGeneric: "Не удалось безопасно подготовить файл. Загрузите другой документ.",
    fileMeta: (pageCount, size) =>
      `${pageCount} ${russianPlural(pageCount, "страница", "страницы", "страниц")} · ${size}`
  },
  configure: {
    step: "Шаг 2 из 4",
    title: "Настройте печать",
    description:
      "Проверьте все параметры перед оплатой. Печать выполняется только в чёрно-белом режиме.",
    remove: "Удалить",
    removing: "Удаляем…",
    removeFailed: "Не удалось удалить файл. Повторите попытку перед продолжением.",
    previewTitle: "Предварительный просмотр",
    previewLoading: "Готовим страницы для просмотра…",
    previewUnavailable: "Предварительный просмотр временно недоступен. Повторите попытку.",
    previewPage: (pageNumber) => `Страница ${pageNumber}`,
    settingsTitle: "Параметры документа",
    pages: "Страницы",
    allPages: (pageCount) => `Все страницы (1–${pageCount})`,
    fromPage: "С какой страницы",
    toPage: "По какую страницу",
    decreaseFromPage: "Уменьшить номер первой страницы",
    increaseFromPage: "Увеличить номер первой страницы",
    decreaseToPage: "Уменьшить номер последней страницы",
    increaseToPage: "Увеличить номер последней страницы",
    orientation: "Ориентация",
    portrait: "Книжная",
    landscape: "Альбомная",
    paperSides: "Печать на сторонах",
    singleSided: "Односторонняя",
    doubleSided: "Двусторонняя",
    copies: "Количество копий",
    copiesAria: "Количество копий",
    decreaseCopies: "Уменьшить количество копий",
    increaseCopies: "Увеличить количество копий",
    summaryTitle: "Итог печати",
    selectedPages: "Выбрано страниц",
    printedSides: "Печатных сторон",
    paperSheets: "Листов бумаги",
    output: "Режим печати",
    estimatedTotal: "Предварительная стоимость",
    reviewAndPay: "Проверить и оплатить",
    backToUpload: "Вернуться к загрузке"
  },
  checkout: {
    step: "Шаг 3 из 4",
    title: "Проверьте заказ и оплатите",
    description: "Проверьте параметры печати. В прототипе оплата на терминале будет имитироваться.",
    selectedPages: (count) =>
      `Выбрано: ${count} ${russianPlural(count, "страница", "страницы", "страниц")}`,
    edit: "Изменить",
    copies: "Копии",
    sides: "Стороны",
    output: "Режим печати",
    prototypeOutcome: "Результат прототипа",
    prototypeDescription: "Выберите результат, чтобы проверить экраны восстановления.",
    outcomeSuccess: "Успешная печать",
    outcomePaymentDeclined: "Платёж отклонён",
    outcomePrinterError: "Ошибка принтера",
    paymentSummary: "Сумма к оплате",
    monochromeSides: (count) =>
      `${count} ${russianPlural(count, "чёрно-белая сторона", "чёрно-белые стороны", "чёрно-белых сторон")}`,
    minimumTransaction: "Минимальная сумма",
    applied: "Применена",
    totalDue: "Итого",
    pay: (price) => `Оплатить ${price}`,
    demoNotice: "Демонстрационный режим: данные карты не используются, списания не будет."
  },
  status: {
    paymentEyebrow: "Безопасная тестовая оплата",
    paymentTitle: "Обрабатываем платёж",
    paymentDescription: "Пожалуйста, подождите и не покидайте этот экран.",
    paymentDetail: "В прототипе реальные деньги не списываются.",
    printingEyebrow: "Шаг 4 из 4",
    printingTitle: "Печатаем документ",
    printingDescription: "Оплата подтверждена. Дождитесь выхода всех листов.",
    printingDetail: "Подготовка · Отправка · Печать",
    actionNeeded: "Требуется действие",
    paymentDeclinedTitle: "Платёж отклонён",
    printerErrorTitle: "Принтер требует внимания",
    paymentDeclinedDescription:
      "Деньги не списаны. Повторите тестовую оплату или вернитесь к настройкам.",
    printerErrorDescription:
      "Печать остановилась до завершения. Не закрывайте сеанс и повторите попытку.",
    paymentDeclinedCode: "ПЛАТЁЖ ОТКЛОНЁН",
    printerErrorCode: "ПРИНТЕР НЕДОСТУПЕН",
    failureDetail: "Тестовая ошибка · Файл по-прежнему доступен в этом сеансе.",
    reviewSettings: "Проверить настройки",
    retryPayment: "Повторить оплату",
    retryPrinting: "Повторить печать",
    completeEyebrow: "Печать завершена",
    completeTitle: "Документы готовы",
    collectSheets: (count) =>
      `Заберите ${count} ${russianPlural(count, "лист", "листа", "листов")} из лотка выдачи.`,
    printed: "Напечатано",
    paid: "Оплачено",
    files: "Файлы",
    deletionScheduled: "Будут удалены",
    finish: "Завершить и удалить файлы"
  },
  idle: {
    countdown: (seconds) =>
      `Осталось ${seconds} ${russianPlural(seconds, "секунда", "секунды", "секунд")}`,
    timeRemaining: "Осталось времени",
    title: "Нужно больше времени?",
    description:
      "Для защиты ваших данных сеанс закроется, а файлы будут удалены, когда таймер дойдёт до нуля.",
    endSession: "Завершить сеанс",
    continue: "Продолжить печать"
  },
  error: {
    eyebrow: "Восстановление терминала",
    title: "Произошла ошибка",
    description: "Документы не были напечатаны, оплата не выполнена.",
    restart: "Перезапустить терминал"
  },
  units: { megabytes: "МБ" }
};

const armenian: MessageCatalog = {
  languageSelectorLabel: "Ընտրեք այլ լեզու",
  brand: {
    name: "Տպման տերմինալ",
    welcomeSubtitle: "Անվտանգ ինքնասպասարկվող տպագրություն",
    activeSubtitle: "Փաստաթղթերի սև-սպիտակ տպագրություն"
  },
  common: {
    ready: "Պատրաստ է",
    cancel: "Չեղարկել",
    printProgress: "Տպման փուլերը",
    steps: ["Վերբեռնում", "Կարգավորումներ", "Վճարում", "Տպագրություն"],
    privacyNotice: "Անձնական ֆայլերն ավտոմատ կհեռացվեն տպման ավարտից հետո։",
    keepSession: "Շարունակել",
    cancelSession: "Չեղարկել տպումը",
    cancelTitle: "Չեղարկե՞լ տպման այս գործընթացը։",
    cancelDescription: "Վճարում չի կատարվի, իսկ վերբեռնված ֆայլերը կհեռացվեն։",
    cleanupInProgress: "Փակում ենք անձնական տպման գործընթացը…",
    cleanupInProgressDescription:
      "Մի փակեք այս էկրանը, մինչև տերմինալը հաստատի, որ ֆայլերի հեռացումը սկսվել է։",
    cleanupPendingTitle: "Ֆայլերի հեռացումը դեռ հաստատված չէ",
    cleanupPendingDescription:
      "Տերմինալը չի կարողացել հաստատել, որ անձնական գործողությունը փակվել է։ Այն պահվել է այս էկրանին՝ անվտանգ կրկին փորձելու համար։ Առայժմ մի հեռացեք։",
    retryCleanup: "Կրկին փորձել անվտանգ հեռացումը",
    monochrome: "Սև-սպիտակ"
  },
  welcome: {
    eyebrow: "Արագ · անվտանգ · ինքնասպասարկում",
    title: "Տպեք հեռախոսից՝ ընդամենը մի քանի քայլով։",
    lead: "Սկանավորեք QR կոդը, վերբեռնեք փաստաթուղթը, ընտրեք տպման կարգավորումները և վճարեք այս էկրանին։",
    availableService: "Հասանելի ծառայություն",
    serviceTitle: "Փաստաթղթերի տպագրություն",
    serviceDescription: "Վերբեռնեք հեռախոսից․ գրանցում և հավելված պետք չեն։",
    starting: "Սկսում ենք…",
    start: "Սկսել տպագրությունը",
    startError: "Չհաջողվեց սկսել տպման գործընթացը։ Փորձեք կրկին։",
    footerSecure: "Անվտանգ տպման գործընթաց",
    footerNoAccount: "Առանց գրանցման",
    footerTouchscreen: "Սենսորային տերմինալ"
  },
  upload: {
    step: "Քայլ 1՝ 4-ից",
    title: "Վերբեռնեք փաստաթուղթը",
    description: "Սկանավորեք QR կոդը հեռախոսով։ Գրանցում և հավելված պետք չեն։",
    instructionCamera: "Բացեք հեռախոսի տեսախցիկը",
    instructionQr: "Ուղղեք տեսախցիկը QR կոդին",
    instructionFile: "Ընտրեք PDF, JPEG կամ PNG ֆայլ",
    sessionLabel: "Ֆայլերի վերբեռնման բաժին",
    qrTitle: "Հեռախոսից անվտանգ վերբեռնման QR կոդ",
    waitingForPhone: "Սպասում ենք հեռախոսի միացմանը",
    uploadedDocument: "Վերբեռնված փաստաթուղթ",
    uploadComplete: "Վերբեռնումն ավարտված է",
    placeholder: "Վերբեռնված ֆայլերն այստեղ կհայտնվեն ավտոմատ։",
    continue: "Անցնել տպման կարգավորումներին",
    continueUnavailable:
      "Տպման կարգավորումները հասանելի կլինեն փաստաթղթի անվտանգության ստուգումից հետո։",
    rejectedHelp: "Հեռախոսից հեռացրեք այս ֆայլը և վերբեռնեք մեկ այլ փաստաթուղթ։",
    refreshError: "Վերբեռնման կարգավիճակը ժամանակավորապես անհասանելի է։ Կրկին կփորձենք ավտոմատ։",
    fileName: (position, extension) =>
      extension === "file" ? `Փաստաթուղթ ${position}` : `Փաստաթուղթ ${position}.${extension}`,
    fileUploading: "Ֆայլը վերբեռնվում է",
    fileQuarantined: "Ֆայլը ստացվել է և սպասում է անվտանգ ստուգման",
    fileChecking: "Ստուգում ենք անվտանգությունը և պատրաստում էջերի նախադիտումները",
    fileRejected: "Ֆայլը մերժվել է",
    fileDeleting: "Ֆայլը հեռացվում է",
    fileDeleted: "Ֆայլը հեռացված է",
    rejectionMalware: "Ֆայլը չի անցել վնասակար բովանդակության անվտանգության ստուգումը։",
    rejectionScanner: "Անվտանգության ստուգումը հասանելի չէ։ Կրկնեք փորձը մի քանի րոպե անց։",
    rejectionEncrypted: "Գաղտնաբառով պաշտպանված փաստաթղթերը հնարավոր չէ տպել։",
    rejectionInvalid: "Ֆայլը վնասված է կամ վավեր PDF փաստաթուղթ կամ պատկեր չէ։",
    rejectionPageLimit: "Փաստաթուղթն ունի ավելի շատ էջ, քան հնարավոր է տպել։",
    rejectionLimits: "Փաստաթուղթը գերազանցում է պատկերի թույլատրելի սահմանները։",
    rejectionTimeout: "Չհաջողվեց հատկացված ժամանակում անվտանգ մշակել փաստաթուղթը։",
    rejectionGeneric: "Չհաջողվեց անվտանգ պատրաստել ֆայլը։ Վերբեռնեք մեկ այլ փաստաթուղթ։",
    fileMeta: (pageCount, size) => `${pageCount} էջ · ${size}`
  },
  configure: {
    step: "Քայլ 2՝ 4-ից",
    title: "Ընտրեք տպման կարգավորումները",
    description: "Վճարումից առաջ ստուգեք բոլոր ընտրանքները։ Տպագրությունը միայն սև-սպիտակ է։",
    remove: "Հեռացնել",
    removing: "Հեռացվում է…",
    removeFailed: "Չհաջողվեց հեռացնել ֆայլը։ Շարունակելուց առաջ փորձեք կրկին։",
    previewTitle: "Փաստաթղթի նախադիտում",
    previewLoading: "Պատրաստում ենք էջերի նախադիտումները…",
    previewUnavailable: "Էջերի նախադիտումը ժամանակավորապես անհասանելի է։ Փորձեք կրկին։",
    previewPage: (pageNumber) => `Էջ ${pageNumber}`,
    settingsTitle: "Փաստաթղթի կարգավորումներ",
    pages: "Էջեր",
    allPages: (pageCount) => `Բոլոր էջերը (1–${pageCount})`,
    fromPage: "Սկսել էջից",
    toPage: "Ավարտել էջով",
    decreaseFromPage: "Նվազեցնել առաջին էջի համարը",
    increaseFromPage: "Ավելացնել առաջին էջի համարը",
    decreaseToPage: "Նվազեցնել վերջին էջի համարը",
    increaseToPage: "Ավելացնել վերջին էջի համարը",
    orientation: "Ուղղություն",
    portrait: "Ուղղահայաց",
    landscape: "Հորիզոնական",
    paperSides: "Թղթի երեսները",
    singleSided: "Միակողմանի",
    doubleSided: "Երկկողմանի",
    copies: "Պատճենների քանակը",
    copiesAria: "Պատճենների քանակը",
    decreaseCopies: "Նվազեցնել պատճենների քանակը",
    increaseCopies: "Ավելացնել պատճենների քանակը",
    summaryTitle: "Տպման ամփոփում",
    selectedPages: "Ընտրված էջեր",
    printedSides: "Տպվող երեսներ",
    paperSheets: "Թղթի թերթեր",
    output: "Տպման ռեժիմ",
    estimatedTotal: "Նախնական արժեքը",
    reviewAndPay: "Ստուգել և վճարել",
    backToUpload: "Վերադառնալ վերբեռնմանը"
  },
  checkout: {
    step: "Քայլ 3՝ 4-ից",
    title: "Ստուգեք պատվերը և վճարեք",
    description: "Ստուգեք տպման տվյալները։ Նախատիպում տերմինալի վճարումը նմանակվելու է։",
    selectedPages: (count) => `Ընտրված է ${count} էջ`,
    edit: "Փոփոխել",
    copies: "Պատճեններ",
    sides: "Երեսներ",
    output: "Տպման ռեժիմ",
    prototypeOutcome: "Նախատիպի արդյունքը",
    prototypeDescription: "Ընտրեք արդյունքը՝ վերականգնման էկրանները ստուգելու համար։",
    outcomeSuccess: "Հաջող տպագրություն",
    outcomePaymentDeclined: "Վճարումը մերժվել է",
    outcomePrinterError: "Տպիչի սխալ",
    paymentSummary: "Վճարման ամփոփում",
    monochromeSides: (count) => `${count} սև-սպիտակ երես`,
    minimumTransaction: "Նվազագույն վճար",
    applied: "Կիրառված է",
    totalDue: "Ընդամենը",
    pay: (price) => `Վճարել ${price}`,
    demoNotice: "Փորձնական ռեժիմ է․ քարտի տվյալներ չեն օգտագործվում, իրական գումար չի գանձվում։"
  },
  status: {
    paymentEyebrow: "Անվտանգ փորձնական վճարում",
    paymentTitle: "Մշակում ենք վճարումը",
    paymentDescription: "Խնդրում ենք սպասել և չհեռանալ այս էկրանից։",
    paymentDetail: "Նախատիպում իրական գումար չի գանձվում։",
    printingEyebrow: "Քայլ 4՝ 4-ից",
    printingTitle: "Տպում ենք փաստաթուղթը",
    printingDescription: "Վճարումը հաստատված է։ Սպասեք մինչև բոլոր թերթերը դուրս գան։",
    printingDetail: "Նախապատրաստում · Ուղարկում · Տպագրություն",
    actionNeeded: "Պահանջվում է գործողություն",
    paymentDeclinedTitle: "Վճարումը մերժվել է",
    printerErrorTitle: "Տպիչը սպասարկման կարիք ունի",
    paymentDeclinedDescription:
      "Գումար չի գանձվել։ Կրկնեք փորձնական վճարումը կամ վերադարձեք կարգավորումներին։",
    printerErrorDescription:
      "Տպագրությունը կանգնել է մինչև ավարտը։ Մի փակեք գործողությունը և փորձեք կրկին։",
    paymentDeclinedCode: "ՎՃԱՐՈՒՄԸ ՄԵՐԺՎԵԼ Է",
    printerErrorCode: "ՏՊԻՉՆ ԱՆՀԱՍԱՆԵԼԻ Է",
    failureDetail: "Փորձնական սխալ · Ձեր ֆայլը դեռ հասանելի է այս գործողության ընթացքում։",
    reviewSettings: "Ստուգել կարգավորումները",
    retryPayment: "Կրկնել վճարումը",
    retryPrinting: "Կրկնել տպագրությունը",
    completeEyebrow: "Տպագրությունն ավարտված է",
    completeTitle: "Փաստաթղթերը պատրաստ են",
    collectSheets: (count) => `Վերցրեք բոլոր ${count} թերթերը ներքևի ելքային դարակից։`,
    printed: "Տպված է",
    paid: "Վճարված է",
    files: "Ֆայլեր",
    deletionScheduled: "Կհեռացվեն",
    finish: "Ավարտել և հեռացնել ֆայլերը"
  },
  idle: {
    countdown: (seconds) => `Մնացել է ${seconds} վայրկյան`,
    timeRemaining: "Մնացած ժամանակը",
    title: "Ավելի շատ ժամանա՞կ է պետք։",
    description:
      "Ձեր տվյալները պաշտպանելու համար ժամանակի ավարտից հետո գործողությունը կփակվի, իսկ ֆայլերը կհեռացվեն։",
    endSession: "Ավարտել գործողությունը",
    continue: "Շարունակել տպագրությունը"
  },
  error: {
    eyebrow: "Տերմինալի վերականգնում",
    title: "Սխալ է տեղի ունեցել",
    description: "Փաստաթղթերը չեն տպվել, և վճարում չի կատարվել։",
    restart: "Վերագործարկել տերմինալը"
  },
  units: { megabytes: "ՄԲ" }
};

export const messages: Record<Locale, MessageCatalog> = {
  en: english,
  ru: russian,
  hy: armenian
};

function russianPlural(count: number, one: string, few: string, many: string): string {
  const modulo100 = count % 100;
  const modulo10 = count % 10;
  if (modulo100 >= 11 && modulo100 <= 14) return many;
  if (modulo10 === 1) return one;
  if (modulo10 >= 2 && modulo10 <= 4) return few;
  return many;
}
