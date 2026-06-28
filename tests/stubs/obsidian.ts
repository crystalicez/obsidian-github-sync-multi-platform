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

export class Notice {
  static messages: string[] = [];

  constructor(message: string) {
    Notice.messages.push(message);
  }
}

class ElementStub {
  text = "";
  onclick?: () => void;

  setText(text: string) {
    this.text = text;
  }

  createEl(_tag: string, options?: { text?: string }) {
    const child = new ElementStub();
    if (options?.text) child.setText(options.text);
    return child;
  }

  createDiv() {
    return new ElementStub();
  }

  addClass(_className: string) {}
}

export class Modal {
  titleEl = new ElementStub();
  contentEl = new ElementStub();
  app: unknown;

  constructor(app: unknown) {
    this.app = app;
  }

  open() {}
  close() {}
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
export async function requestUrl(_options: unknown): Promise<unknown> {
  throw new Error("requestUrl is not implemented in tests");
}
export const moment = (value: number) => ({ format: (_format: string) => String(value) });
