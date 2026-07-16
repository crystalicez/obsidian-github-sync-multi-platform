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

export class ElementStub {
  text = "";
  title = "";
  disabled = false;
  onclick?: () => void;
  onpointerdown?: (event: PointerEvent) => void;
  onpointermove?: (event: PointerEvent) => void;
  onpointerup?: (event: PointerEvent) => void;
  onpointercancel?: (event: PointerEvent) => void;
  offsetWidth = 120;
  style: Record<string, string> = {};
  children: ElementStub[] = [];
  attributes: Record<string, string> = {};
  classes = new Set<string>();
  private parent?: ElementStub;
  private readonly root: { mutations: number };

  constructor(root?: { mutations: number }, parent?: ElementStub) {
    this.root = root ?? { mutations: 0 };
    this.parent = parent;
  }

  get mutationCount(): number { return this.root.mutations; }

  private mutate(): void { this.root.mutations++; }

  setText(text: string) {
    this.text = text;
    this.mutate();
  }

  createEl(tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }) {
    const child = new ElementStub(this.root, this);
    this.children.push(child);
    this.mutate();
    if (options?.text) child.setText(options.text);
    if (options?.cls) child.addClass(options.cls);
    for (const [name, value] of Object.entries(options?.attr ?? {})) child.setAttribute(name, value);
    if (tag === "button") modalButtons.push({ text: options?.text ?? "", click: () => child.onclick?.() });
    return child;
  }

  createDiv(options?: string | { text?: string; cls?: string }) {
    return this.createEl("div", typeof options === "string" ? { cls: options } : options);
  }

  empty() {
    this.children = [];
    this.text = "";
    this.mutate();
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = undefined;
    this.mutate();
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
    if (name === "title") this.title = value;
    this.mutate();
  }

  addClass(className: string) {
    for (const name of className.split(/\s+/u).filter(Boolean)) this.classes.add(name);
    this.mutate();
  }

  removeClass(className: string) {
    this.classes.delete(className);
    this.mutate();
  }

  flattenText(): string {
    return [this.text, ...this.children.map(child => child.flattenText())].filter(Boolean).join(" ");
  }

  findByText(text: string): ElementStub | undefined {
    if (this.text === text) return this;
    for (const child of this.children) {
      const found = child.findByText(text);
      if (found) return found;
    }
    return undefined;
  }

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

export class WorkspaceLeaf {
  app: unknown;
  constructor(app: unknown = { workspace: { getActiveFile: () => null } }) { this.app = app; }
}

export class ItemView {
  app: any;
  contentEl = new ElementStub();
  constructor(public readonly leaf: WorkspaceLeaf) { this.app = leaf.app; }
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
