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
    paidSessionError: string;
    printerUnavailableError: string;
    printerOutOfPaperError: string;
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
    uploadedDocuments: string;
    documentsReady: (count: number) => string;
    addMoreHint: string;
    uploadComplete: string;
    placeholder: string;
    continue: string;
    continueWithCount: (count: number) => string;
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
    descriptionMany: (count: number) => string;
    documents: string;
    documentsTitle: (count: number) => string;
    documentsHint: string;
    documentLabel: (name: string) => string;
    documentPosition: (position: number, total: number) => string;
    documentSelectedPages: (selected: number, total: number) => string;
    removeDocument: (name: string) => string;
    addDocument: string;
    settingsAppliesToAll: (count: number) => string;
    settingsAppliesToOne: string;
    remove: string;
    removing: string;
    removeFailed: string;
    previewTitle: string;
    previewHint: string;
    previewLoading: string;
    previewUnavailable: string;
    previewPage: (pageNumber: number) => string;
    previewExcludedPage: (pageNumber: number) => string;
    previewSkippedPage: (pageNumber: number) => string;
    previewExcludedBadge: string;
    previewSkippedBadge: string;
    previewExcludedCount: (count: number) => string;
    previewPrint: string;
    previewDontPrint: string;
    previewClose: string;
    previewPrintedNotice: string;
    previewExcludedNotice: string;
    previewSkippedNotice: (pageStart: number, pageEnd: number) => string;
    previewLastPageNotice: string;
    previewTooComplexNotice: string;
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
    copiesAriaFor: (name: string) => string;
    decreaseCopiesFor: (name: string) => string;
    increaseCopiesFor: (name: string) => string;
    summaryTitle: string;
    selectedPages: string;
    printedSides: string;
    paperSheets: string;
    output: string;
    total: string;
    priceCalculating: string;
    priceCalculatingHelp: string;
    priceUnavailable: string;
    priceUnavailableHelp: string;
    priceRetry: string;
    reviewAndPay: string;
    backToUpload: string;
  };
  checkout: {
    step: string;
    title: string;
    description: string;
    selectedPages: (count: number) => string;
    documentCount: (count: number) => string;
    documentPages: (count: number, ranges: string) => string;
    documentSummary: (pages: number, copies: number, sides: string) => string;
    documentPagesUnknown: string;
    edit: string;
    copies: string;
    sides: string;
    paperSheets: string;
    output: string;
    serviceFee: string;
    tax: string;
    prototypeOutcome: string;
    prototypeDescription: string;
    outcomeSuccess: string;
    outcomePaymentDeclined: string;
    outcomePrinterError: string;
    outcomePrinterUnconfirmed: string;
    paymentSummary: string;
    monochromeSides: (count: number) => string;
    minimumTransaction: string;
    applied: string;
    totalDue: string;
    pay: (price: string) => string;
    paymentStartFailed: string;
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
    /**
     * What the machine is doing right now, in the customer's words. The screen
     * shows exactly one of these at a time and never runs ahead of what the
     * control plane has actually reported.
     */
    printingStages: {
      PREPARING_FILES: string;
      CHECKING_PRINTER: string;
      PREPARING_PAGES: string;
      SENDING_PAGES: string;
      PRINTING: string;
      FINISHING: string;
    };
    actionNeeded: string;
    paymentStatusUnavailableTitle: string;
    paymentStatusUnavailableDescription: string;
    paymentStatusUnavailableCode: string;
    paymentCompensatedTitle: string;
    paymentCompensatedDescription: string;
    paymentCompensatedCode: string;
    paymentDeclinedTitle: string;
    printerStatusUnavailableTitle: string;
    printerStatusUnavailableDescription: string;
    printerStatusUnavailableCode: string;
    printerStatusUnavailableDetail: string;
    printerOperatorRequiredTitle: string;
    printerOperatorRequiredDescription: string;
    printerOperatorRequiredCode: string;
    printerOperatorRequiredDetail: string;
    printerErrorTitle: string;
    paymentDeclinedDescription: string;
    printerErrorDescription: string;
    paymentDeclinedCode: string;
    printerErrorCode: string;
    printerRefundNotice: string;
    printerRecoveryTitle: string;
    printerRecoveryDescription: string;
    printerRecoveryCode: string;
    printerRecoveryDetail: string;
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
    paidSessionError:
      "The previous paid print has not finished. Operator assistance is required before a new print can start.",
    printerUnavailableError: "Printer temporarily unavailable — please contact staff.",
    printerOutOfPaperError: "The printer is out of paper — please contact staff.",
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
    instructionFile: "Choose one or more PDF, JPEG, or PNG files",
    sessionLabel: "Upload session",
    qrTitle: "QR code for secure phone upload",
    waitingForPhone: "Waiting for your phone",
    uploadedDocument: "Uploaded document",
    uploadedDocuments: "Uploaded documents",
    documentsReady: (count) => (count === 1 ? "1 document ready" : `${count} documents ready`),
    addMoreHint: "Keep sending from your phone to add more documents.",
    uploadComplete: "Upload complete",
    placeholder: "Your uploaded files will appear here automatically.",
    continue: "Continue to print settings",
    continueWithCount: (count) => `Continue with ${count} documents`,
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
    descriptionMany: (count) =>
      `Choose the pages for each of your ${count} documents, then the settings for the whole job. All output is black-and-white.`,
    documents: "Documents",
    documentsTitle: (count) => (count === 1 ? "Your document" : `Your ${count} documents`),
    documentsHint: "Page choices apply to the document they sit under.",
    documentLabel: (name) => `Settings for ${name}`,
    documentPosition: (position, total) => `Document ${position} of ${total}`,
    documentSelectedPages: (selected, total) =>
      `Printing ${selected} of ${total} ${total === 1 ? "page" : "pages"}`,
    removeDocument: (name) => `Remove ${name}`,
    addDocument: "Add another document",
    settingsAppliesToAll: (count) => `Applied to all ${count} documents.`,
    settingsAppliesToOne: "Applied to your document.",
    remove: "Remove",
    removing: "Removing…",
    removeFailed: "The file could not be removed. Try again before continuing.",
    previewTitle: "Document preview",
    previewHint: "Tap a page to see it larger and choose whether to print it.",
    previewLoading: "Preparing page previews…",
    previewUnavailable: "Page previews are temporarily unavailable. Try again.",
    previewPage: (pageNumber) => `Page ${pageNumber}`,
    previewExcludedPage: (pageNumber) => `Page ${pageNumber}, excluded from printing`,
    previewSkippedPage: (pageNumber) => `Page ${pageNumber}, outside the selected range`,
    previewExcludedBadge: "Excluded",
    previewSkippedBadge: "Not selected",
    previewExcludedCount: (count) =>
      `${count} ${count === 1 ? "page is" : "pages are"} excluded from printing.`,
    previewPrint: "Print",
    previewDontPrint: "Don't print",
    previewClose: "Close",
    previewPrintedNotice: "This page will be printed.",
    previewExcludedNotice: "This page will not be printed.",
    previewSkippedNotice: (pageStart, pageEnd) =>
      `This page is outside the selected range (${pageStart}–${pageEnd}), so it is not printed.`,
    previewLastPageNotice: "At least one page has to stay selected.",
    previewTooComplexNotice:
      "This document is already split into as many separate page groups as the printer accepts.",
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
    copiesAriaFor: (name) => `Number of copies of ${name}`,
    decreaseCopiesFor: (name) => `Decrease copies of ${name}`,
    increaseCopiesFor: (name) => `Increase copies of ${name}`,
    summaryTitle: "Print summary",
    selectedPages: "Selected pages",
    printedSides: "Printed sides",
    paperSheets: "Paper sheets",
    output: "Output",
    total: "Total",
    priceCalculating: "Calculating…",
    priceCalculatingHelp: "The kiosk is confirming the price for these settings.",
    priceUnavailable: "The price could not be confirmed.",
    priceUnavailableHelp: "The price could not be confirmed, so payment is not available yet.",
    priceRetry: "Try again",
    reviewAndPay: "Review and pay",
    backToUpload: "Back to upload"
  },
  checkout: {
    step: "Step 3 of 4",
    title: "Review and pay",
    description: "Check your print details. The prototype will simulate payment at this kiosk.",
    selectedPages: (count) => `${count} selected ${count === 1 ? "page" : "pages"}`,
    documentCount: (count) => `${count} documents`,
    documentPages: (count, ranges) => `${count} ${count === 1 ? "page" : "pages"} · ${ranges}`,
    documentSummary: (pages, copies, sides) =>
      `${pages} ${pages === 1 ? "page" : "pages"} · ${copies}× · ${sides}`,
    documentPagesUnknown: "Pages pending",
    edit: "Edit",
    copies: "Copies",
    sides: "Sides",
    paperSheets: "Paper sheets",
    output: "Output",
    serviceFee: "Service fee",
    tax: "Tax",
    prototypeOutcome: "Prototype outcome",
    prototypeDescription: "Choose a result to verify the kiosk recovery screens.",
    outcomeSuccess: "Successful print",
    outcomePaymentDeclined: "Payment declined",
    outcomePrinterError: "Printer error",
    outcomePrinterUnconfirmed: "Unconfirmed print",
    paymentSummary: "Payment summary",
    monochromeSides: (count) => `${count} black-and-white ${count === 1 ? "side" : "sides"}`,
    minimumTransaction: "Minimum transaction",
    applied: "Applied",
    totalDue: "Total due",
    pay: (price) => `Pay ${price}`,
    paymentStartFailed: "Payment could not be started. Please try again.",
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
    printingStages: {
      PREPARING_FILES: "Preparing your files",
      CHECKING_PRINTER: "Checking the printer",
      PREPARING_PAGES: "Preparing pages",
      SENDING_PAGES: "Sending pages to the printer",
      PRINTING: "Printing your documents",
      FINISHING: "Finishing your print"
    },
    actionNeeded: "Action needed",
    paymentStatusUnavailableTitle: "Payment status is temporarily unavailable",
    paymentStatusUnavailableDescription:
      "The payment may still be in progress. Retry the status check without starting another payment.",
    paymentStatusUnavailableCode: "PAYMENT STATUS UNKNOWN",
    paymentCompensatedTitle: "Payment arrived too late",
    paymentCompensatedDescription:
      "This payment cannot be used for printing and has been recorded for compensation. Ask an operator for help if a real charge appears.",
    paymentCompensatedCode: "COMPENSATION REQUIRED",
    paymentDeclinedTitle: "Payment was declined",
    printerStatusUnavailableTitle: "Print status is temporarily unavailable",
    printerStatusUnavailableDescription:
      "The print job may still be in progress. Retry the same paid request without paying again.",
    printerStatusUnavailableCode: "PRINT STATUS UNKNOWN",
    printerStatusUnavailableDetail:
      "Your payment remains attached to this session · No new payment will be started.",
    printerOperatorRequiredTitle: "Printing needs operator assistance",
    printerOperatorRequiredDescription:
      "The system could not accept this print request or status check. Keep this paid session on screen and ask an operator for help.",
    printerOperatorRequiredCode: "PRINT REQUEST BLOCKED",
    printerOperatorRequiredDetail: "Do not pay again · An operator must verify the paid session.",
    printerErrorTitle: "The printer needs attention",
    paymentDeclinedDescription:
      "Nothing was charged. You can retry the demo payment or return to your settings.",
    printerErrorDescription:
      "Nothing was printed. Your payment has been recorded for a refund, and your documents are scheduled for secure deletion.",
    paymentDeclinedCode: "PAYMENT DECLINED",
    printerErrorCode: "NOTHING PRINTED",
    printerRefundNotice: "Refund recorded · Ask an operator if it does not appear.",
    printerRecoveryTitle: "The printer could not confirm your job",
    printerRecoveryDescription:
      "Some or all of your pages may have printed. Check the output tray and ask an operator before paying again.",
    printerRecoveryCode: "RESULT UNCONFIRMED",
    printerRecoveryDetail: "An operator will settle this · No automatic refund has been recorded.",
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
    deletionScheduled: "Secure deletion scheduled",
    finish: "Finish"
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
    paidSessionError:
      "Предыдущая оплаченная печать ещё не завершена. Для запуска новой печати обратитесь к оператору.",
    printerUnavailableError: "Принтер временно недоступен — обратитесь к персоналу.",
    printerOutOfPaperError: "В принтере закончилась бумага — обратитесь к персоналу.",
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
    instructionFile: "Выберите один или несколько файлов PDF, JPEG или PNG",
    sessionLabel: "Сеанс загрузки",
    qrTitle: "QR-код для безопасной загрузки с телефона",
    waitingForPhone: "Ожидаем подключение телефона",
    uploadedDocument: "Загруженный документ",
    uploadedDocuments: "Загруженные документы",
    documentsReady: (count) => (count === 1 ? "1 документ готов" : `Готовых документов: ${count}`),
    addMoreHint: "Продолжайте отправлять с телефона, чтобы добавить документы.",
    uploadComplete: "Загрузка завершена",
    placeholder: "Загруженные файлы автоматически появятся здесь.",
    continue: "Перейти к настройкам печати",
    continueWithCount: (count) => `Продолжить с ${count} документами`,
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
    descriptionMany: (count) =>
      `Выберите страницы для каждого из ${count} документов, затем настройки для всей печати. Печать только чёрно-белая.`,
    documents: "Документы",
    documentsTitle: (count) => (count === 1 ? "Ваш документ" : `Ваши документы: ${count}`),
    documentsHint: "Выбор страниц относится к документу, под которым он находится.",
    documentLabel: (name) => `Настройки для ${name}`,
    documentPosition: (position, total) => `Документ ${position} из ${total}`,
    documentSelectedPages: (selected, total) =>
      `Печатается ${selected} из ${total} ${russianPlural(total, "страницы", "страниц", "страниц")}`,
    removeDocument: (name) => `Удалить ${name}`,
    addDocument: "Добавить ещё документ",
    settingsAppliesToAll: (count) => `Применяется ко всем документам: ${count}.`,
    settingsAppliesToOne: "Применяется к вашему документу.",
    remove: "Удалить",
    removing: "Удаляем…",
    removeFailed: "Не удалось удалить файл. Повторите попытку перед продолжением.",
    previewTitle: "Предварительный просмотр",
    previewHint: "Нажмите на страницу, чтобы увеличить её и решить, печатать ли её.",
    previewLoading: "Готовим страницы для просмотра…",
    previewUnavailable: "Предварительный просмотр временно недоступен. Повторите попытку.",
    previewPage: (pageNumber) => `Страница ${pageNumber}`,
    previewExcludedPage: (pageNumber) => `Страница ${pageNumber}, исключена из печати`,
    previewSkippedPage: (pageNumber) => `Страница ${pageNumber}, вне выбранного диапазона`,
    previewExcludedBadge: "Исключена",
    previewSkippedBadge: "Не выбрана",
    previewExcludedCount: (count) =>
      `Исключено из печати: ${count} ${russianPlural(count, "страница", "страницы", "страниц")}.`,
    previewPrint: "Печатать",
    previewDontPrint: "Не печатать",
    previewClose: "Закрыть",
    previewPrintedNotice: "Эта страница будет напечатана.",
    previewExcludedNotice: "Эта страница не будет напечатана.",
    previewSkippedNotice: (pageStart, pageEnd) =>
      `Эта страница вне выбранного диапазона (${pageStart}–${pageEnd}), поэтому не печатается.`,
    previewLastPageNotice: "Хотя бы одна страница должна остаться выбранной.",
    previewTooComplexNotice:
      "Документ уже разбит на максимальное число отдельных групп страниц, которое принимает принтер.",
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
    copiesAriaFor: (name) => `Количество копий: ${name}`,
    decreaseCopiesFor: (name) => `Уменьшить количество копий: ${name}`,
    increaseCopiesFor: (name) => `Увеличить количество копий: ${name}`,
    summaryTitle: "Итог печати",
    selectedPages: "Выбрано страниц",
    printedSides: "Печатных сторон",
    paperSheets: "Листов бумаги",
    output: "Режим печати",
    total: "Итого",
    priceCalculating: "Расчёт…",
    priceCalculatingHelp: "Терминал подтверждает стоимость для выбранных параметров.",
    priceUnavailable: "Не удалось подтвердить стоимость.",
    priceUnavailableHelp: "Стоимость не подтверждена, поэтому оплата пока недоступна.",
    priceRetry: "Повторить",
    reviewAndPay: "Проверить и оплатить",
    backToUpload: "Вернуться к загрузке"
  },
  checkout: {
    step: "Шаг 3 из 4",
    title: "Проверьте заказ и оплатите",
    description: "Проверьте параметры печати. В прототипе оплата на терминале будет имитироваться.",
    selectedPages: (count) =>
      `Выбрано: ${count} ${russianPlural(count, "страница", "страницы", "страниц")}`,
    documentCount: (count) =>
      `${count} ${russianPlural(count, "документ", "документа", "документов")}`,
    documentPages: (count, ranges) =>
      `${count} ${russianPlural(count, "страница", "страницы", "страниц")} · ${ranges}`,
    documentSummary: (pages, copies, sides) =>
      `${pages} ${russianPlural(pages, "страница", "страницы", "страниц")} · ${copies}× · ${sides}`,
    documentPagesUnknown: "Страницы уточняются",
    edit: "Изменить",
    copies: "Копии",
    sides: "Стороны",
    paperSheets: "Листов бумаги",
    output: "Режим печати",
    serviceFee: "Сервисный сбор",
    tax: "Налог",
    prototypeOutcome: "Результат прототипа",
    prototypeDescription: "Выберите результат, чтобы проверить экраны восстановления.",
    outcomeSuccess: "Успешная печать",
    outcomePaymentDeclined: "Платёж отклонён",
    outcomePrinterError: "Ошибка принтера",
    outcomePrinterUnconfirmed: "Печать не подтверждена",
    paymentSummary: "Сумма к оплате",
    monochromeSides: (count) =>
      `${count} ${russianPlural(count, "чёрно-белая сторона", "чёрно-белые стороны", "чёрно-белых сторон")}`,
    minimumTransaction: "Минимальная сумма",
    applied: "Применена",
    totalDue: "Итого",
    pay: (price) => `Оплатить ${price}`,
    paymentStartFailed: "Не удалось начать оплату. Попробуйте ещё раз.",
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
    printingStages: {
      PREPARING_FILES: "Готовим ваши файлы",
      CHECKING_PRINTER: "Проверяем принтер",
      PREPARING_PAGES: "Готовим страницы",
      SENDING_PAGES: "Отправляем страницы на принтер",
      PRINTING: "Печатаем ваши документы",
      FINISHING: "Завершаем печать"
    },
    actionNeeded: "Требуется действие",
    paymentStatusUnavailableTitle: "Статус платежа временно недоступен",
    paymentStatusUnavailableDescription:
      "Платёж всё ещё может обрабатываться. Повторите проверку статуса, не начиная новый платёж.",
    paymentStatusUnavailableCode: "СТАТУС ПЛАТЕЖА НЕИЗВЕСТЕН",
    paymentCompensatedTitle: "Платёж поступил слишком поздно",
    paymentCompensatedDescription:
      "Этот платёж нельзя использовать для печати; он зарегистрирован для возврата. Если появилось реальное списание, обратитесь к оператору.",
    paymentCompensatedCode: "ТРЕБУЕТСЯ ВОЗВРАТ",
    paymentDeclinedTitle: "Платёж отклонён",
    printerStatusUnavailableTitle: "Статус печати временно недоступен",
    printerStatusUnavailableDescription:
      "Задание печати всё ещё может выполняться. Повторите этот же оплаченный запрос, не оплачивая его снова.",
    printerStatusUnavailableCode: "СТАТУС ПЕЧАТИ НЕИЗВЕСТЕН",
    printerStatusUnavailableDetail:
      "Платёж остаётся привязан к сеансу · Новый платёж не будет создан.",
    printerOperatorRequiredTitle: "Для печати нужна помощь оператора",
    printerOperatorRequiredDescription:
      "Система не приняла запрос на печать или проверку его статуса. Оставьте этот оплаченный сеанс на экране и обратитесь к оператору.",
    printerOperatorRequiredCode: "ЗАПРОС ПЕЧАТИ ЗАБЛОКИРОВАН",
    printerOperatorRequiredDetail:
      "Не оплачивайте повторно · Оператор должен проверить оплаченный сеанс.",
    printerErrorTitle: "Печать не выполнена",
    paymentDeclinedDescription:
      "Деньги не списаны. Повторите тестовую оплату или вернитесь к настройкам.",
    printerErrorDescription:
      "Ничего не напечатано. Возврат средств зафиксирован, а документы поставлены в очередь на безопасное удаление.",
    paymentDeclinedCode: "ПЛАТЁЖ ОТКЛОНЁН",
    printerErrorCode: "НИЧЕГО НЕ НАПЕЧАТАНО",
    printerRefundNotice: "Возврат зафиксирован · Обратитесь к оператору, если он не поступит.",
    printerRecoveryTitle: "Принтер не подтвердил задание",
    printerRecoveryDescription:
      "Часть страниц могла быть напечатана. Проверьте лоток выдачи и обратитесь к оператору, прежде чем платить снова.",
    printerRecoveryCode: "РЕЗУЛЬТАТ НЕ ПОДТВЕРЖДЁН",
    printerRecoveryDetail: "Вопрос решает оператор · Автоматический возврат не оформлен.",
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
    deletionScheduled: "Безопасное удаление запланировано",
    finish: "Завершить"
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
    welcomeSubtitle: "Ինքնուրույն և անվտանգ տպում",
    activeSubtitle: "Փաստաթղթերի սև-սպիտակ տպում"
  },
  common: {
    ready: "Պատրաստ է",
    cancel: "Չեղարկել",
    printProgress: "Տպման փուլերը",
    steps: ["Վերբեռնում", "Կարգավորումներ", "Վճարում", "Տպում"],
    privacyNotice: "Ձեր ֆայլերն ավտոմատ կհեռացվեն տպման գործընթացի ավարտին։",
    keepSession: "Շարունակել տպումը",
    cancelSession: "Այո, չեղարկել",
    cancelTitle: "Չեղարկե՞լ տպումը։",
    cancelDescription: "Վճարում չի կատարվի, իսկ վերբեռնված ֆայլերը կհեռացվեն։",
    cleanupInProgress: "Հեռացնում ենք ֆայլերը…",
    cleanupInProgressDescription:
      "Մի փակեք այս էկրանը, մինչև հաստատվի, որ ֆայլերի հեռացումը սկսվել է։",
    cleanupPendingTitle: "Չհաջողվեց հաստատել ֆայլերի հեռացումը",
    cleanupPendingDescription:
      "Տերմինալը չի կարողացել հաստատել, որ տպման գործընթացն ավարտվել է։ Ֆայլերն անվտանգ հեռացնելու համար փորձեք կրկին։ Մինչ այդ մի հեռացեք։",
    retryCleanup: "Կրկին հեռացնել ֆայլերը",
    monochrome: "Սև-սպիտակ"
  },
  welcome: {
    eyebrow: "Արագ · անվտանգ · ինքնուրույն",
    title: "Տպեք հեռախոսից՝ ընդամենը մի քանի քայլով։",
    lead: "Սկանավորեք QR կոդը, հեռախոսից վերբեռնեք փաստաթուղթը, ընտրեք կարգավորումներն ու վճարեք տերմինալում։",
    availableService: "Հասանելի ծառայություն",
    serviceTitle: "Փաստաթղթերի տպում",
    serviceDescription: "Վերբեռնեք հեռախոսից՝ առանց գրանցման կամ հավելվածի։",
    starting: "Սկսում ենք…",
    start: "Սկսել տպումը",
    startError: "Չհաջողվեց սկսել տպումը։ Փորձեք կրկին։",
    paidSessionError:
      "Նախորդ վճարված տպումը դեռ ավարտված չէ։ Նոր տպում սկսելու համար դիմեք սպասարկողին։",
    printerUnavailableError: "Տպիչը ժամանակավորապես անհասանելի է․ դիմեք սպասարկողին։",
    printerOutOfPaperError: "Տպիչում թուղթը վերջացել է․ դիմեք սպասարկողին։",
    footerSecure: "Անվտանգ կապ",
    footerNoAccount: "Գրանցում պետք չէ",
    footerTouchscreen: "Սենսորային էկրան"
  },
  upload: {
    step: "Քայլ 1 / 4",
    title: "Վերբեռնեք փաստաթուղթը",
    description: "Սկանավորեք QR կոդը հեռախոսով։ Գրանցում և հավելված պետք չեն։",
    instructionCamera: "Բացեք հեռախոսի տեսախցիկը",
    instructionQr: "Ուղղեք տեսախցիկը դեպի QR կոդը",
    instructionFile: "Ընտրեք մեկ կամ մի քանի PDF, JPEG կամ PNG ֆայլ",
    sessionLabel: "Ֆայլերի վերբեռնման պատուհան",
    qrTitle: "Հեռախոսից անվտանգ վերբեռնման QR կոդ",
    waitingForPhone: "Սպասում ենք, որ հեռախոսը միանա",
    uploadedDocument: "Վերբեռնված փաստաթուղթ",
    uploadedDocuments: "Վերբեռնված փաստաթղթեր",
    documentsReady: (count) => `Պատրաստ է ${count} փաստաթուղթ`,
    addMoreHint: "Շարունակեք ուղարկել հեռախոսից՝ ևս փաստաթղթեր ավելացնելու համար։",
    uploadComplete: "Ֆայլը վերբեռնված է",
    placeholder: "Վերբեռնված ֆայլերն այստեղ կհայտնվեն ավտոմատ։",
    continue: "Անցնել տպման կարգավորումներին",
    continueWithCount: (count) => `Շարունակել ${count} փաստաթղթով`,
    continueUnavailable:
      "Տպման կարգավորումները հասանելի կդառնան, երբ փաստաթուղթն անցնի անվտանգության ստուգումը։",
    rejectedHelp: "Հեռացրեք այս ֆայլը հեռախոսում և վերբեռնեք մեկ ուրիշը։",
    refreshError:
      "Վերբեռնումների կարգավիճակն այժմ հասանելի չէ։ Այն կշարունակենք ավտոմատ թարմացնել։",
    fileName: (position, extension) =>
      extension === "file" ? `Փաստաթուղթ ${position}` : `Փաստաթուղթ ${position}.${extension}`,
    fileUploading: "Ֆայլը վերբեռնվում է",
    fileQuarantined: "Ֆայլը ստացվել է․ սպասում է անվտանգության ստուգման",
    fileChecking: "Ստուգում ենք ֆայլն ու պատրաստում էջերի նախադիտումը",
    fileRejected: "Ֆայլը մերժվել է",
    fileDeleting: "Ֆայլը հեռացվում է",
    fileDeleted: "Ֆայլը հեռացվել է",
    rejectionMalware: "Ֆայլը չի անցել վնասակար ծրագրերի ստուգումը։",
    rejectionScanner: "Անվտանգության ստուգումն այժմ հասանելի չէ։ Փորձեք մի քանի րոպեից։",
    rejectionEncrypted: "Գաղտնաբառով պաշտպանված այս փաստաթուղթը հնարավոր չէ տպել։",
    rejectionInvalid: "Ֆայլը վնասված է կամ վավեր PDF փաստաթուղթ կամ պատկեր չէ։",
    rejectionPageLimit: "Փաստաթղթի էջերի քանակը գերազանցում է թույլատրելի սահմանը։",
    rejectionLimits: "Պատկերի չափերը գերազանցում են թույլատրելի սահմանը։",
    rejectionTimeout: "Փաստաթղթի անվտանգ մշակումը սահմանված ժամանակում չի ավարտվել։",
    rejectionGeneric: "Չհաջողվեց անվտանգ մշակել այս ֆայլը։ Վերբեռնեք մեկ ուրիշը։",
    fileMeta: (pageCount, size) => `${pageCount} էջ · ${size}`
  },
  configure: {
    step: "Քայլ 2 / 4",
    title: "Ընտրեք տպման կարգավորումները",
    description: "Վճարելուց առաջ ստուգեք կարգավորումները։ Տպումը միայն սև-սպիտակ է։",
    descriptionMany: (count) =>
      `Ընտրեք էջերը ${count} փաստաթղթերից յուրաքանչյուրի համար, ապա՝ ամբողջ տպման կարգավորումները։ Տպումը միայն սև-սպիտակ է։`,
    documents: "Փաստաթղթեր",
    documentsTitle: (count) => (count === 1 ? "Ձեր փաստաթուղթը" : `Ձեր ${count} փաստաթղթերը`),
    documentsHint: "Էջերի ընտրությունը վերաբերում է այն փաստաթղթին, որի տակ գտնվում է։",
    documentLabel: (name) => `${name}՝ կարգավորումներ`,
    documentPosition: (position, total) => `Փաստաթուղթ ${position}՝ ${total}-ից`,
    documentSelectedPages: (selected, total) => `Տպվում է ${total} էջից ${selected}-ը`,
    removeDocument: (name) => `Հեռացնել ${name}`,
    addDocument: "Ավելացնել ևս մեկ փաստաթուղթ",
    settingsAppliesToAll: (count) => `Կիրառվում է բոլոր ${count} փաստաթղթերի վրա։`,
    settingsAppliesToOne: "Կիրառվում է ձեր փաստաթղթի վրա։",
    remove: "Հեռացնել",
    removing: "Հեռացվում է…",
    removeFailed: "Չհաջողվեց հեռացնել ֆայլը։ Շարունակելուց առաջ փորձեք կրկին։",
    previewTitle: "Փաստաթղթի նախադիտում",
    previewHint: "Հպեք էջին՝ այն մեծացնելու և տպումից հանելու կամ վերադարձնելու համար։",
    previewLoading: "Պատրաստում ենք էջերի նախադիտումները…",
    previewUnavailable: "Էջերի նախադիտումն այժմ հասանելի չէ։ Փորձեք կրկին։",
    previewPage: (pageNumber) => `Էջ ${pageNumber}`,
    previewExcludedPage: (pageNumber) => `Էջ ${pageNumber}․ չի տպվի`,
    previewSkippedPage: (pageNumber) => `Էջ ${pageNumber}․ ընտրված միջակայքից դուրս է`,
    previewExcludedBadge: "Չի տպվի",
    previewSkippedBadge: "Միջակայքից դուրս",
    previewExcludedCount: (count) => `Տպումից հանված էջերի քանակը՝ ${count}։`,
    previewPrint: "Տպել այս էջը",
    previewDontPrint: "Չտպել այս էջը",
    previewClose: "Փակել",
    previewPrintedNotice: "Այս էջը կտպվի։",
    previewExcludedNotice: "Այս էջը չի տպվի։",
    previewSkippedNotice: (pageStart, pageEnd) =>
      `Այս էջը ${pageStart}–${pageEnd} միջակայքից դուրս է և չի տպվի։`,
    previewLastPageNotice: "Պետք է ընտրված մնա առնվազն մեկ էջ։",
    previewTooComplexNotice:
      "Այլ էջ հանել հնարավոր չէ․ ընտրված էջերն արդեն բաժանված են տպիչի թույլատրած առավելագույն թվով առանձին խմբերի։",
    settingsTitle: "Փաստաթղթի կարգավորումներ",
    pages: "Էջեր",
    allPages: (pageCount) => (pageCount === 1 ? "Միակ էջը" : `Բոլոր էջերը (1–${pageCount})`),
    fromPage: "Առաջին էջ",
    toPage: "Վերջին էջ",
    decreaseFromPage: "Նվազեցնել առաջին էջի համարը",
    increaseFromPage: "Ավելացնել առաջին էջի համարը",
    decreaseToPage: "Նվազեցնել վերջին էջի համարը",
    increaseToPage: "Ավելացնել վերջին էջի համարը",
    orientation: "Էջի դիրքը",
    portrait: "Ուղղահայաց",
    landscape: "Հորիզոնական",
    paperSides: "Տպման կողմերը",
    singleSided: "Միակողմանի",
    doubleSided: "Երկկողմանի",
    copies: "Պատճենների քանակը",
    copiesAria: "Պատճենների քանակը",
    decreaseCopies: "Նվազեցնել պատճենների քանակը",
    increaseCopies: "Ավելացնել պատճենների քանակը",
    copiesAriaFor: (name) => `${name}՝ պատճենների քանակը`,
    decreaseCopiesFor: (name) => `${name}՝ նվազեցնել պատճենների քանակը`,
    increaseCopiesFor: (name) => `${name}՝ ավելացնել պատճենների քանակը`,
    summaryTitle: "Տպման ամփոփում",
    selectedPages: "Ընտրված էջեր",
    printedSides: "Տպվող կողմեր",
    paperSheets: "Թերթերի քանակը",
    output: "Տպման ռեժիմ",
    total: "Ընդամենը",
    priceCalculating: "Հաշվում ենք…",
    priceCalculatingHelp: "Հաշվում ենք ընտրված կարգավորումներով տպման արժեքը։",
    priceUnavailable: "Չհաջողվեց հաշվարկել արժեքը։",
    priceUnavailableHelp: "Քանի դեռ արժեքը հաշվարկված չէ, վճարել հնարավոր չէ։",
    priceRetry: "Փորձել կրկին",
    reviewAndPay: "Ստուգել և վճարել",
    backToUpload: "Վերադառնալ փաստաթղթին"
  },
  checkout: {
    step: "Քայլ 3 / 4",
    title: "Ստուգեք և վճարեք",
    description:
      "Ստուգեք տպման կարգավորումները։ Փորձնական տարբերակում վճարումը միայն նմանակվում է։",
    selectedPages: (count) => `Ընտրված էջերի քանակը՝ ${count}`,
    documentCount: (count) => `${count} փաստաթուղթ`,
    documentPages: (count, ranges) => `${count} էջ · ${ranges}`,
    documentSummary: (pages, copies, sides) => `${pages} էջ · ${copies}× · ${sides}`,
    documentPagesUnknown: "Էջերը ճշտվում են",
    edit: "Փոխել",
    copies: "Պատճենների քանակը",
    sides: "Տպման կողմերը",
    paperSheets: "Թերթերի քանակը",
    output: "Տպման ռեժիմ",
    serviceFee: "Սպասարկման վճար",
    tax: "Հարկ",
    prototypeOutcome: "Փորձնական արդյունք",
    prototypeDescription: "Ընտրեք արդյունքը՝ սխալի և վերականգնման էկրանները ստուգելու համար։",
    outcomeSuccess: "Տպումը հաջողվել է",
    outcomePaymentDeclined: "Վճարումը մերժվել է",
    outcomePrinterError: "Տպիչի խափանում",
    outcomePrinterUnconfirmed: "Չհաստատված տպում",
    paymentSummary: "Վճարման տվյալներ",
    monochromeSides: (count) => `${count} սև-սպիտակ կողմ`,
    minimumTransaction: "Նվազագույն վճար",
    applied: "Կիրառված է",
    totalDue: "Ընդամենը",
    pay: (price) => `Վճարել ${price}`,
    paymentStartFailed: "Չհաջողվեց սկսել վճարումը։ Փորձեք կրկին։",
    demoNotice: "Փորձնական ռեժիմ է․ քարտի տվյալներ չեն օգտագործվում, իրական գումար չի գանձվում։"
  },
  status: {
    paymentEyebrow: "Անվտանգ փորձնական վճարում",
    paymentTitle: "Վճարումը կատարվում է",
    paymentDescription: "Սպասեք և մի փակեք այս էկրանը։",
    paymentDetail: "Փորձնական տարբերակում իրական գումար չի գանձվում։",
    printingEyebrow: "Քայլ 4 / 4",
    printingTitle: "Փաստաթուղթը տպվում է",
    printingDescription: "Վճարումը հաստատվել է։ Սպասեք, մինչև բոլոր թերթերը դուրս գան։",
    printingDetail: "Նախապատրաստում · Ուղարկում · Տպում",
    printingStages: {
      PREPARING_FILES: "Պատրաստում ենք ձեր ֆայլերը",
      CHECKING_PRINTER: "Ստուգում ենք տպիչը",
      PREPARING_PAGES: "Պատրաստում ենք էջերը",
      SENDING_PAGES: "Ուղարկում ենք էջերը տպիչին",
      PRINTING: "Տպում ենք ձեր փաստաթղթերը",
      FINISHING: "Ավարտում ենք տպումը"
    },
    actionNeeded: "Ձեր միջամտությունն է պետք",
    paymentStatusUnavailableTitle: "Վճարման կարգավիճակը ժամանակավորապես հասանելի չէ",
    paymentStatusUnavailableDescription:
      "Վճարումը կարող է դեռ ընթացքի մեջ լինել։ Կրկին ստուգեք կարգավիճակը՝ առանց նոր վճարում սկսելու։",
    paymentStatusUnavailableCode: "ՎՃԱՐՄԱՆ ԿԱՐԳԱՎԻՃԱԿՆ ԱՆՀԱՅՏ Է",
    paymentCompensatedTitle: "Վճարումը չափազանց ուշ է ստացվել",
    paymentCompensatedDescription:
      "Այս վճարումը չի կարող օգտագործվել տպման համար և գրանցվել է վերադարձի համար։ Իրական գանձում տեսնելու դեպքում դիմեք սպասարկողին։",
    paymentCompensatedCode: "ԳՈՒՄԱՐԸ ՊԵՏՔ Է ՎԵՐԱԴԱՐՁՎԻ",
    paymentDeclinedTitle: "Վճարումը մերժվել է",
    printerStatusUnavailableTitle: "Տպման կարգավիճակը ժամանակավորապես հասանելի չէ",
    printerStatusUnavailableDescription:
      "Տպման աշխատանքը կարող է դեռ ընթացքի մեջ լինել։ Կրկին ուղարկեք նույն վճարված հարցումը՝ առանց նորից վճարելու։",
    printerStatusUnavailableCode: "ՏՊՄԱՆ ԿԱՐԳԱՎԻՃԱԿՆ ԱՆՀԱՅՏ Է",
    printerStatusUnavailableDetail: "Վճարումը մնում է կապված այս սեանսին · Նոր վճարում չի սկսվի։",
    printerOperatorRequiredTitle: "Տպումը շարունակելու համար սպասարկողի օգնությունն է պետք",
    printerOperatorRequiredDescription:
      "Համակարգը չի ընդունել տպման հարցումը կամ դրա կարգավիճակի ստուգումը։ Պահեք այս վճարված սեանսը էկրանին և դիմեք սպասարկողին։",
    printerOperatorRequiredCode: "ՏՊՄԱՆ ՀԱՐՑՈՒՄԸ ՉԻ ԸՆԴՈՒՆՎԵԼ",
    printerOperatorRequiredDetail: "Կրկին մի վճարեք · Սպասարկողը պետք է ստուգի վճարված սեանսը։",
    printerErrorTitle: "Տպումը չի կատարվել",
    paymentDeclinedDescription: "Գումար չի գանձվել։ Փորձեք կրկին կամ վերադարձեք կարգավորումներին։",
    printerErrorDescription:
      "Ոչինչ չի տպվել։ Գումարի վերադարձը գրանցված է, իսկ փաստաթղթերի անվտանգ հեռացումը նախատեսված է։",
    paymentDeclinedCode: "ՎՃԱՐՈՒՄԸ ՄԵՐԺՎԵԼ Է",
    printerErrorCode: "ՈՉԻՆՉ ՉԻ ՏՊՎԵԼ",
    printerRefundNotice: "Վերադարձը գրանցված է · Դիմեք օպերատորին, եթե այն չհասնի։",
    printerRecoveryTitle: "Տպիչը չհաստատեց աշխատանքը",
    printerRecoveryDescription:
      "Էջերի մի մասը կարող է տպված լինել։ Ստուգեք ելքի դարակը և դիմեք օպերատորին՝ նախքան կրկին վճարելը։",
    printerRecoveryCode: "ԱՐԴՅՈՒՆՔԸ ՀԱՍՏԱՏՎԱԾ ՉԷ",
    printerRecoveryDetail: "Հարցը կլուծի օպերատորը · Ավտոմատ վերադարձ չի գրանցվել։",
    failureDetail: "Փորձնական սխալ · Ձեր ֆայլը դեռ հասանելի է։",
    reviewSettings: "Վերադառնալ կարգավորումներին",
    retryPayment: "Կրկնել վճարումը",
    retryPrinting: "Կրկնել տպումը",
    completeEyebrow: "Տպումն ավարտված է",
    completeTitle: "Փաստաթուղթը պատրաստ է",
    collectSheets: (count) =>
      count === 1
        ? "Վերցրեք տպված թերթը ներքևի դարակից։"
        : `Ներքևի դարակում ${count} տպված թերթ կա։ Վերցրեք բոլորը։`,
    printed: "Տպված փաստաթուղթ",
    paid: "Վճարված է",
    files: "Ֆայլեր",
    deletionScheduled: "Անվտանգ հեռացումը նախատեսված է",
    finish: "Ավարտել"
  },
  idle: {
    countdown: (seconds) => `Մնացել է ${seconds} վայրկյան`,
    timeRemaining: "Մնացել է",
    title: "Ավելի շատ ժամանա՞կ է պետք։",
    description:
      "Ձեր տվյալները պաշտպանելու համար, երբ ժամանակը սպառվի, տպման գործընթացը կավարտվի, իսկ ֆայլերը կհեռացվեն։",
    endSession: "Ավարտել հիմա",
    continue: "Շարունակել"
  },
  error: {
    eyebrow: "Տերմինալի սխալ",
    title: "Տեխնիկական խնդիր է առաջացել",
    description: "Փաստաթուղթը չի տպվել, վճարում չի կատարվել։",
    restart: "Սկսել նորից"
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
