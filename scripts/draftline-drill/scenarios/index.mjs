import standalone from "./standalone.mjs";
import hybrid from "./hybrid.mjs";
import developer from "./developer.mjs";
import coverage from "./coverage.mjs";

export const scenarios = [...standalone, ...hybrid, ...developer, ...coverage];
