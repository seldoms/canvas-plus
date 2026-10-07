/**
 * 分镜示意稿 —— 铅笔手稿风 SVG。按「场景类型 × 景别 × 人数」生成构图：
 * 让文字分镜在关键帧产出之前就有可读的视觉形态（正式接线后替换为真实分镜图/关键帧缩略图）。
 */
import { useId, type JSX } from "react";

import type { MockScene, MockShot } from "./mock-data";

const PAPER = "#f6f2e9";
const INK = "#6b6259";
const INK_SOFT = "#a39e93";
const ACCENT = "#b3342b";

type SceneKind = "corridor" | "banquet" | "kitchen" | "window";

function sceneKindOf(scene: MockScene | undefined, shot: MockShot): SceneKind {
    const text = `${scene?.locationId || ""} ${shot.storyboard.background || ""} ${shot.storyboard.action || ""}`;
    if (/外廊|大堂|门厅/.test(text)) return "corridor";
    if (/主桌|宴会厅/.test(text)) return "banquet";
    if (/窗/.test(text)) return "window";
    return "kitchen";
}

/** 单个铅笔小人：x=中心，feetY=脚底，h=身高 */
function Person({ x, feetY, h, flip = false }: { x: number; feetY: number; h: number; flip?: boolean }) {
    const r = h * 0.17;
    const headCy = feetY - h + r;
    const neckY = headCy + r;
    const hipY = feetY - h * 0.42;
    const armY = neckY + h * 0.12;
    const dir = flip ? -1 : 1;
    return (
        <g stroke={INK} strokeWidth={1.6} strokeLinecap="round" fill="none">
            <circle cx={x} cy={headCy} r={r} fill={PAPER} />
            <path d={`M ${x} ${neckY} Q ${x + 2 * dir} ${(neckY + hipY) / 2} ${x} ${hipY}`} />
            <path d={`M ${x} ${armY} L ${x + dir * h * 0.2} ${armY + h * 0.18}`} />
            <path d={`M ${x} ${armY} L ${x - dir * h * 0.16} ${armY + h * 0.2}`} />
            <path d={`M ${x} ${hipY} L ${x - h * 0.12} ${feetY}`} />
            <path d={`M ${x} ${hipY} L ${x + h * 0.14} ${feetY}`} />
        </g>
    );
}

/** 近景/特写：头肩构图 */
function Portrait({ x, baseY, h, detail }: { x: number; baseY: number; h: number; detail: boolean }) {
    const r = h * 0.3;
    const headCy = baseY - h + r;
    return (
        <g stroke={INK} strokeWidth={1.8} strokeLinecap="round" fill="none">
            <circle cx={x} cy={headCy} r={r} fill={PAPER} />
            <path d={`M ${x - r * 1.7} ${baseY} Q ${x - r * 1.2} ${headCy + r * 0.9} ${x - r * 0.5} ${headCy + r * 1.05}`} />
            <path d={`M ${x + r * 1.7} ${baseY} Q ${x + r * 1.2} ${headCy + r * 0.9} ${x + r * 0.5} ${headCy + r * 1.05}`} />
            {detail ? (
                <>
                    <path d={`M ${x - r * 0.42} ${headCy - r * 0.12} h ${r * 0.26}`} />
                    <path d={`M ${x + r * 0.16} ${headCy - r * 0.12} h ${r * 0.26}`} />
                    <path d={`M ${x - r * 0.18} ${headCy + r * 0.42} Q ${x} ${headCy + r * 0.52} ${x + r * 0.18} ${headCy + r * 0.42}`} />
                </>
            ) : null}
        </g>
    );
}

function CorridorBg() {
    return (
        <g stroke={INK_SOFT} strokeWidth={1.4} strokeLinecap="round" fill="none">
            <path d="M 24 46 V 262" />
            <path d="M 62 46 V 256" />
            <path d="M 100 46 V 252" />
            <path d="M 12 286 L 176 246" />
            <path d="M 12 306 L 176 262" />
            <rect x="126" y="88" width="44" height="158" fill={PAPER} />
            <path d="M 148 88 V 246" />
            <text x="148" y="142" textAnchor="middle" fontSize="20" fill={ACCENT} stroke="none" fontFamily="serif">囍</text>
            <path d="M 30 66 Q 66 58 102 64" />
        </g>
    );
}

function BanquetBg() {
    return (
        <g stroke={INK_SOFT} strokeWidth={1.4} strokeLinecap="round" fill="none">
            <path d="M 30 12 V 40 M 90 8 V 44 M 150 12 V 40" />
            <circle cx="30" cy="50" r="10" />
            <circle cx="90" cy="56" r="12" />
            <circle cx="150" cy="50" r="10" />
            <text x="90" y="112" textAnchor="middle" fontSize="22" fill={ACCENT} stroke="none" fontFamily="serif">囍</text>
            <ellipse cx="90" cy="248" rx="58" ry="17" fill={PAPER} />
            <circle cx="70" cy="244" r="4" />
            <circle cx="94" cy="241" r="4" />
            <circle cx="114" cy="246" r="4" />
            <path d="M 30 238 Q 22 252 32 262 M 150 238 Q 158 252 148 262" />
        </g>
    );
}

function KitchenBg() {
    return (
        <g stroke={INK_SOFT} strokeWidth={1.4} strokeLinecap="round" fill="none">
            <path d="M 10 30 L 82 132 M 170 30 L 98 132" />
            <path d="M 10 300 L 82 176 M 170 300 L 98 176" />
            <path d="M 82 132 V 176 M 98 132 V 176 M 82 132 H 98 M 82 176 H 98" />
            <path d="M 40 96 V 210 M 58 108 V 196" />
            <path d="M 140 96 V 210 M 122 108 V 196" />
            <path d="M 90 20 V 52" />
            <circle cx="90" cy="60" r="7" />
        </g>
    );
}

function WindowBg() {
    return (
        <g stroke={INK_SOFT} strokeWidth={1.4} strokeLinecap="round" fill="none">
            <rect x="96" y="56" width="66" height="120" fill={PAPER} />
            <path d="M 129 56 V 176 M 96 116 H 162" />
            <path d="M 100 60 L 122 172 M 116 58 L 140 172" strokeDasharray="3 5" opacity={0.7} />
            <path d="M 88 52 Q 84 120 90 180 M 170 52 Q 174 120 168 180" />
            <path d="M 20 250 H 90" />
        </g>
    );
}

const BG: Record<SceneKind, () => JSX.Element> = {
    corridor: CorridorBg,
    banquet: BanquetBg,
    kitchen: KitchenBg,
    window: WindowBg,
};

/** 景别决定人物在画面中的体量与位置 */
function Figures({ kind, shotSize, people }: { kind: SceneKind; shotSize?: string; people: number }) {
    if (people <= 0) return null;
    const groundY = kind === "banquet" ? 236 : kind === "corridor" ? 262 : 252;
    if (shotSize === "特写") {
        return <Portrait x={90} baseY={300} h={210} detail />;
    }
    if (shotSize === "近景") {
        return (
            <g>
                {Array.from({ length: Math.min(people, 2) }).map((_, i) => (
                    <Portrait key={i} x={people > 1 ? 62 + i * 56 : 90} baseY={310} h={140} detail={false} />
                ))}
            </g>
        );
    }
    const h = shotSize === "远景" ? 22 : shotSize === "全景" ? 46 : 92;
    const count = Math.min(people, 3);
    const spread = count > 1 ? 44 : 0;
    return (
        <g>
            {Array.from({ length: count }).map((_, i) => (
                <Person key={i} x={90 + (i - (count - 1) / 2) * spread} feetY={groundY} h={h} flip={i % 2 === 1} />
            ))}
        </g>
    );
}

export function StoryboardSketch({ scene, shot, className }: { scene?: MockScene; shot: MockShot; className?: string }) {
    const rawId = useId().replace(/[^a-zA-Z0-9]/g, "");
    const kind = sceneKindOf(scene, shot);
    const Bg = BG[kind];
    const people = shot.storyboard.characters?.length || 0;
    return (
        <svg viewBox="0 0 180 320" className={className} role="img" aria-label={`镜 ${shot.index} 示意稿`}>
            <defs>
                <filter id={`rough-${rawId}`}>
                    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" result="n" />
                    <feDisplacementMap in="SourceGraphic" in2="n" scale="1.6" />
                </filter>
            </defs>
            <rect width="180" height="320" fill={PAPER} />
            <g filter={`url(#rough-${rawId})`}>
                <Bg />
                <Figures kind={kind} shotSize={shot.storyboard.shotSize} people={people} />
            </g>
            <rect x="3.5" y="3.5" width="173" height="313" fill="none" stroke={INK} strokeWidth="1.4" rx="2" opacity="0.65" />
        </svg>
    );
}
