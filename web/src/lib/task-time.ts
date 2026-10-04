/**
 * 任务时间显示格式（产品负责人定性）。
 *
 * 原话：「下面的这个任务提交时间搞得简单一点，**只需要几时几分就可以了**，
 *        只有在之前的任务里面才需要显示日期和时间，但是**也不需要显示年和秒**」。
 *
 * 规则：
 * - **今天**提交的任务 → 只给「时:分」（`14:32`）
 * - **往日**（非今天）的任务 → 「月-日 时:分」（`10-04 14:32`）
 * - **一律不带年、不带秒**
 *
 * 注：跨年也只给「月-日 时:分」——负责人明确说不需要年；列表本身按时间倒序，
 * 顺序已经表达了先后，不需要靠年份消歧。
 */

const pad2 = (value: number) => String(value).padStart(2, "0");

/** 把任意时间输入解析成 Date；拿不到合法时间返回 null。 */
function toDate(input: unknown): Date | null {
    if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
    if (typeof input === "number") {
        const fromNumber = new Date(input);
        return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
    }
    if (typeof input === "string" && input.trim()) {
        const fromString = new Date(input);
        return Number.isNaN(fromString.getTime()) ? null : fromString;
    }
    return null;
}

const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * 任务时间显示串。
 *
 * @param input 时间（ISO 字符串 / 毫秒时间戳 / Date）
 * @param now 参照的「现在」，默认取当前时间（测试可注入）
 * @returns 今天 `HH:mm`；往日 `MM-DD HH:mm`；无法解析返回空串（由调用方决定占位）
 */
export function formatTaskTime(input: unknown, now: Date = new Date()): string {
    const date = toDate(input);
    if (!date) return "";
    const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    if (isSameDay(date, now)) return clock;
    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${clock}`;
}
