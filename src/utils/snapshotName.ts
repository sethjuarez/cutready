/** Generate a human-friendly snapshot name based on the current time. */
export function generateSnapshotName(): string {
  const now = new Date();
  const h = now.getHours();
  const m = String(now.getMinutes()).padStart(2, "0");
  const period = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = dayNames[now.getDay()];
  return `${day} ${period} ${h % 12 || 12}:${m}`;
}
