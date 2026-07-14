export class TAbstractFile {
  path: string;

  constructor(path: string = "") {
    this.path = path;
  }
}

export class TFile extends TAbstractFile {
  extension: string;
  stat: { size: number; mtime: number };

  constructor(path: string, bytes: Uint8Array = new Uint8Array()) {
    super(path);
    this.extension = path.includes(".") ? path.split(".").pop()?.toLowerCase() ?? "" : "";
    this.stat = { size: bytes.byteLength, mtime: Date.now() };
  }
}

export class TFolder extends TAbstractFile {}

export class Notice {
  static messages: string[] = [];

  constructor(message: string) {
    Notice.messages.push(message);
  }
}

export const modalEvents: string[] = [];
export const modalButtons: Array<{ text: string; click: () => void }> = [];
export function resetModalTestState() {
  modalEvents.length = 0;
  modalButtons.length = 0;
}

class ElementStub {
  text = "";
  onclick?: () => void;
  onpointerdown?: (event: PointerEvent) => void;
  onpointermove?: (event: PointerEvent) => void;
  onpointerup?: (event: PointerEvent) => void;
  onpointercancel?: (event: PointerEvent) => void;
  offsetWidth = 120;
  style: Record<string, string> = {};

  setText(text: string) {
    this.text = text;
  }

  createEl(tag: string, options?: { text?: string }) {
    const child = new ElementStub();
    if (options?.text) child.setText(options.text);
    if (tag === "button") modalButtons.push({ text: options?.text ?? "", click: () => child.onclick?.() });
    return child;
  }

  createDiv(_options?: unknown) {
    return new ElementStub();
  }

  addClass(_className: string) {}
  getBoundingClientRect() { return { left: 0, width: 300 }; }
  setPointerCapture(_pointerId: number) {}
  releasePointerCapture(_pointerId: number) {}
}

export class Modal {
  titleEl = new ElementStub();
  contentEl = new ElementStub();
  app: unknown;

  constructor(app: unknown) {
    this.app = app;
    modalEvents.push("construct");
  }

  open() { modalEvents.push("open"); }
  close() { modalEvents.push("close"); }
}

export class Plugin {}
export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl = new ElementStub();

  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
}

export class Setting {
  constructor(_container: unknown) {}
  setName(_name: string) { return this; }
  setDesc(_desc: string) { return this; }
  setHeading() { return this; }
  setClass(_className: string) { return this; }
  addToggle(_cb: unknown) { return this; }
  addText(_cb: unknown) { return this; }
  addTextArea(_cb: unknown) { return this; }
  addDropdown(_cb: unknown) { return this; }
  addButton(_cb: unknown) { return this; }
}

export const Platform = { isDesktopApp: true, isMacOS: false };
export function setIcon(_el: unknown, _icon: string) {}
let requestUrlHandler: ((options: unknown) => Promise<unknown>) | null = null;
export function setRequestUrlHandler(handler: ((options: unknown) => Promise<unknown>) | null) {
  requestUrlHandler = handler;
}
export async function requestUrl(options: unknown): Promise<unknown> {
  if (requestUrlHandler) return requestUrlHandler(options);
  throw new Error("requestUrl is not implemented in tests");
}
export const moment = (value: number) => ({ format: (_format: string) => String(value) });
