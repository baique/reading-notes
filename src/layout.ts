export interface Layout {
	/** 上半高度占比 */
	top: number;
	/** 上半里问题栏的宽度占比 */
	questions: number;
}

export const TOP_MIN = 0.28;
export const TOP_MAX = 0.86;
export const ASK_MIN = 0.22;
export const ASK_MAX = 0.6;

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * 拖动中的新比例。
 * base 必须是「这次按下时分隔条所在的位置」，不能是渲染时的旧值，否则拖动会跳。
 * step 是 (指针位移 / 容器尺寸)。
 */
export function dragValue(base: number, step: number, invert: boolean, min: number, max: number): number {
	return clamp(invert ? base - step : base + step, min, max);
}
