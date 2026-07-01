import en from "src/lang/locale/en";
import { moment } from "obsidian";
export { moment };

export type LangMap = Record<string, string>;

export const localeMap: { [k: string]: Partial<typeof en> } = {
    en,
};

const locale = en;

function getValueFromPath(root: Record<string, unknown>, path: string): unknown {
    const normalized = path
        .replace(/\[(?:'([^']*)'|"([^"]*)"|([^'\]"[\]]+))\]/g, (_m, g1, g2, g3) => {
            const key = g1 ?? g2 ?? g3;
            return "." + key;
        })
        .replace(/^\./, "");

    if (normalized === "") return undefined;

    const parts = normalized.split(".");
    let cur: unknown = root;
    for (const part of parts) {
        if (cur == null) return undefined;
        if (part === "") return undefined;
        if (typeof cur === "object") {
            cur = (cur as Record<string, unknown>)[part];
        } else {
            return undefined;
        }
    }
    return cur;
}

function interpolate(str: string, params: Record<string, unknown>): string {
    if (!str || typeof str !== "string") return String(str ?? "");
    return str.replace(/\$\{([^}]+)\}/g, (_match, expression) => {
        const path = expression.trim();
        if (!/^[A-Za-z0-9_.[\]'"\s-]+$/.test(path)) {
            return "";
        }
        const val = getValueFromPath(params, path);
        if (val === undefined || val === null) return "";
        if (typeof val === "string") return val;
        if (typeof val === "number" || typeof val === "boolean" || typeof val === "bigint") {
            return String(val);
        }
        try {
            return JSON.stringify(val);
        } catch {
            return "";
        }
    });
}

export function $(
    str: Extract<keyof typeof en, string>,
    params?: Record<string, unknown>
): string {
    const key = str;
    const fallback = en[key];
    const result = (locale && (locale[key] as string)) ?? fallback ?? key;

    if (params) {
        return interpolate(result, params);
    }

    return result;
}