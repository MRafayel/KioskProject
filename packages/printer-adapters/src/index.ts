export * from "./types.js";
export {
  MockPrinterAdapter,
  MOCK_PRINTER_SCENARIOS,
  type MockPrinterAdapterOptions,
  type MockPrinterScenario
} from "./mock/adapter.js";
export {
  capabilitySnapshotHash,
  mapDeviceCapabilities,
  IPP_COLOR_MODE_BY_COLOR_MODE,
  IPP_MEDIA_BY_PAPER_SIZE,
  IPP_SIDES_BY_DUPLEX_MODE,
  type CapabilityMappingLimits,
  type DeviceCapabilityDeclaration
} from "./capabilities.js";
export {
  isApprovedQueueName,
  normalizeQueueName,
  parseQueueAllowlist,
  selectApprovedQueue,
  type QueueApprovalPolicy,
  type QueueRejectionReason,
  type QueueSelection
} from "./queues.js";
export {
  DeviceOperationJournal,
  deviceJobName,
  parseDeviceJobName,
  type DeviceOperationDocument,
  type DeviceOperationRecord,
  type ParsedJobName
} from "./operation-journal.js";
export {
  assertSubmittable,
  operationStatus,
  unknownStatus,
  withHonestConfidence,
  OPERATION_ID_PATTERN
} from "./submission.js";
export {
  WindowsPrinterAdapter,
  type DeviceHostTransport,
  type WindowsPrinterAdapterOptions
} from "./windows/adapter.js";
export {
  ChildProcessDeviceHost,
  deviceHostCommand,
  type DeviceHostCommand,
  type ChildProcessDeviceHostOptions
} from "./windows/child-process-host.js";
export {
  DEVICE_HOST_PROTOCOL_VERSION,
  type DeviceHostBinding,
  type DeviceHostDocumentRequest,
  type DeviceHostOperationReport,
  type DeviceHostRequest
} from "./windows/protocol.js";
export {
  createPrinterAdapter,
  PRINTER_ADAPTER_KINDS,
  type PrinterAdapterFactoryOptions,
  type PrinterAdapterKind
} from "./factory.js";
