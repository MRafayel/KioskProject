export const locales = ["hy", "ru", "en"] as const;
export type Locale = (typeof locales)[number];

const hy = {
  languageName: "Հայերեն",
  pageTitle: "Ֆայլի վերբեռնում տպման համար",
  brand: "Տպման տերմինալ",
  brandNote: "Անվտանգ ֆայլի փոխանցում",
  loadingTitle: "Միանում ենք տպման տերմինալին…",
  loadingText: "Խնդրում ենք մի փակեք այս էջը։",
  invalidTitle: "Չհաջողվեց բացել տպման գործողությունը",
  invalidLink: "Այս հղումը վավեր չէ։ Նորից սկանավորեք տերմինալի էկրանին երևացող QR կոդը։",
  missingGrant:
    "Այս էջը պետք է բացել տերմինալի QR կոդից։ Եթե էջը թարմացրել եք, վերադարձեք տերմինալ և նորից սկանավորեք կոդը։",
  claimed:
    "Այս տպման գործողությունն արդեն միացված է մեկ այլ հեռախոսի։ Շարունակեք այդ հեռախոսով կամ սկսեք նոր գործողություն տերմինալից։",
  expired: "Տպման գործողության ժամկետն ավարտվել է։ Սկսեք նոր գործողություն տերմինալից։",
  connectionError: "Չհաջողվեց կապվել տերմինալի հետ։ Ստուգեք կապը և փորձեք կրկին։",
  genericError:
    "Չհաջողվեց ավարտել գործողությունը։ Փորձեք կրկին կամ սկսեք նոր գործողություն տերմինալից։",
  retry: "Փորձել կրկին",
  eyebrow: "Քայլ 1 · Ֆայլի փոխանցում",
  title: "Վերբեռնեք տպվող ֆայլը",
  intro: "Ընտրեք PDF, JPEG կամ PNG ֆայլ։ Այն կփոխանցվի անմիջապես ձեր բացած տպման գործողությանը։",
  privacy: "Ֆայլը հասանելի կլինի միայն այս ժամանակավոր գործողության ընթացքում։",
  sessionReady: "Հեռախոսը միացված է տերմինալին",
  sessionClosed: "Տպման գործողությունը փակված է",
  expires: "Գործողությունը հասանելի է մինչև {time}",
  chooseFile: "Ընտրել ֆայլ",
  chooseAnother: "Ընտրել ևս մեկ ֆայլ",
  fileHint: "PDF, JPEG կամ PNG · առավելագույնը {size}",
  uploading: "Ֆայլը փոխանցվում է",
  uploadProgress: "Փոխանցված է {percent}%",
  uploadSuccess: "Ֆայլը փոխանցվել է։ Այն արդեն երևում է տպման տերմինալում։",
  filesTitle: "Փոխանցված ֆայլեր",
  filesEmpty: "Դեռ ֆայլ չեք փոխանցել։",
  document: "Փաստաթուղթ {number}",
  image: "Պատկեր {number}",
  fileSize: "{size}",
  remove: "Հեռացնել",
  removing: "Հեռացվում է…",
  statusUploading: "Փոխանցվում է",
  statusQuarantined: "Ընդունված է · ստուգվում է",
  statusRejected: "Ֆայլը մերժվել է",
  statusDeleting: "Հեռացվում է",
  statusDeleted: "Հեռացված է",
  emptyFile: "Դատարկ ֆայլ հնարավոր չէ տպել։ Ընտրեք բովանդակություն ունեցող ֆայլ։",
  fileTooLarge: "Ֆայլը գերազանցում է թույլատրելի չափը։ Ընտրեք ավելի փոքր ֆայլ։",
  unsupportedFile: "Ընտրեք PDF, JPEG կամ PNG ձևաչափով ֆայլ։",
  fileLimit: "Այս գործողության համար այլևս հնարավոր չէ նոր ֆայլ ավելացնել։",
  uploadFailed: "Ֆայլը չփոխանցվեց։ Ստուգեք կապը և փորձեք կրկին։",
  deleteFailed: "Ֆայլը չհեռացվեց։ Փորձեք կրկին։",
  sessionUnavailable:
    "Այս գործողությունն այլևս չի ընդունում ֆայլեր։ Սկսեք նոր գործողություն տերմինալից։",
  footer: "Ֆայլերը պահվում են միայն տպման գործողությունն ավարտելու համար։"
} as const;

export type Messages = { [Key in keyof typeof hy]: string };

const ru: Messages = {
  languageName: "Русский",
  pageTitle: "Загрузка файла для печати",
  brand: "Терминал печати",
  brandNote: "Безопасная передача файла",
  loadingTitle: "Подключаемся к терминалу…",
  loadingText: "Пожалуйста, не закрывайте эту страницу.",
  invalidTitle: "Не удалось открыть сеанс печати",
  invalidLink: "Эта ссылка недействительна. Повторно отсканируйте QR-код на экране терминала.",
  missingGrant:
    "Эту страницу нужно открыть по QR-коду терминала. Если вы обновили страницу, вернитесь к терминалу и отсканируйте код ещё раз.",
  claimed:
    "К этому сеансу печати уже подключён другой телефон. Продолжите на нём или начните новый сеанс на терминале.",
  expired: "Время сеанса печати истекло. Начните новый сеанс на терминале.",
  connectionError: "Не удалось связаться с терминалом. Проверьте подключение и повторите попытку.",
  genericError:
    "Не удалось завершить действие. Повторите попытку или начните новый сеанс на терминале.",
  retry: "Повторить",
  eyebrow: "Шаг 1 · Передача файла",
  title: "Загрузите файл для печати",
  intro: "Выберите файл PDF, JPEG или PNG. Он будет отправлен прямо в открытый вами сеанс печати.",
  privacy: "Файл будет доступен только в рамках этого временного сеанса.",
  sessionReady: "Телефон подключён к терминалу",
  sessionClosed: "Сеанс печати завершён",
  expires: "Сеанс доступен до {time}",
  chooseFile: "Выбрать файл",
  chooseAnother: "Выбрать ещё один файл",
  fileHint: "PDF, JPEG или PNG · не более {size}",
  uploading: "Передаём файл",
  uploadProgress: "Передано {percent}%",
  uploadSuccess: "Файл передан и уже отображается на терминале печати.",
  filesTitle: "Переданные файлы",
  filesEmpty: "Вы пока не передали ни одного файла.",
  document: "Документ {number}",
  image: "Изображение {number}",
  fileSize: "{size}",
  remove: "Удалить",
  removing: "Удаляем…",
  statusUploading: "Передаётся",
  statusQuarantined: "Принят · проверяется",
  statusRejected: "Файл отклонён",
  statusDeleting: "Удаляется",
  statusDeleted: "Удалён",
  emptyFile: "Пустой файл нельзя напечатать. Выберите файл с содержимым.",
  fileTooLarge: "Файл превышает допустимый размер. Выберите файл меньшего размера.",
  unsupportedFile: "Выберите файл в формате PDF, JPEG или PNG.",
  fileLimit: "В этот сеанс больше нельзя добавить файл.",
  uploadFailed: "Не удалось передать файл. Проверьте подключение и повторите попытку.",
  deleteFailed: "Не удалось удалить файл. Повторите попытку.",
  sessionUnavailable: "Этот сеанс больше не принимает файлы. Начните новый сеанс на терминале.",
  footer: "Файлы хранятся только до завершения сеанса печати."
};

const en: Messages = {
  languageName: "English",
  pageTitle: "Upload a file for printing",
  brand: "Print terminal",
  brandNote: "Secure file transfer",
  loadingTitle: "Connecting to the terminal…",
  loadingText: "Please keep this page open.",
  invalidTitle: "We could not open the print session",
  invalidLink: "This link is not valid. Scan the QR code shown on the terminal again.",
  missingGrant:
    "Open this page from the terminal's QR code. If you refreshed the page, return to the terminal and scan the code again.",
  claimed:
    "Another phone is already connected to this print session. Continue on that phone or start a new session at the terminal.",
  expired: "This print session has expired. Start a new session at the terminal.",
  connectionError: "We could not reach the terminal. Check your connection and try again.",
  genericError:
    "We could not complete that action. Try again or start a new session at the terminal.",
  retry: "Try again",
  eyebrow: "Step 1 · File transfer",
  title: "Upload the file you want to print",
  intro:
    "Choose a PDF, JPEG, or PNG file. It will be sent directly to the print session you opened.",
  privacy: "The file is available only for this temporary print session.",
  sessionReady: "Your phone is connected to the terminal",
  sessionClosed: "Print session closed",
  expires: "Session available until {time}",
  chooseFile: "Choose a file",
  chooseAnother: "Choose another file",
  fileHint: "PDF, JPEG, or PNG · up to {size}",
  uploading: "Transferring file",
  uploadProgress: "{percent}% transferred",
  uploadSuccess: "The file was transferred and is now visible on the print terminal.",
  filesTitle: "Transferred files",
  filesEmpty: "You have not transferred a file yet.",
  document: "Document {number}",
  image: "Image {number}",
  fileSize: "{size}",
  remove: "Remove",
  removing: "Removing…",
  statusUploading: "Transferring",
  statusQuarantined: "Received · checking",
  statusRejected: "File rejected",
  statusDeleting: "Removing",
  statusDeleted: "Removed",
  emptyFile: "An empty file cannot be printed. Choose a file that contains content.",
  fileTooLarge: "This file is larger than the allowed size. Choose a smaller file.",
  unsupportedFile: "Choose a PDF, JPEG, or PNG file.",
  fileLimit: "No more files can be added to this session.",
  uploadFailed: "The file was not transferred. Check your connection and try again.",
  deleteFailed: "The file was not removed. Try again.",
  sessionUnavailable: "This session no longer accepts files. Start a new session at the terminal.",
  footer: "Files are retained only as long as needed to complete the print session."
};

export const messages: Record<Locale, Messages> = { hy, ru, en };

export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}
