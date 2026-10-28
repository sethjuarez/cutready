import standalone from "./standalone.mjs";
import hybrid from "./hybrid.mjs";
import developer from "./developer.mjs";

export const scenarios = [...standalone, ...hybrid, ...developer];
