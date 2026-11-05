/** The fields a save's time can come from. */
export interface SaveTimes {
  time_seconds: number;
  author_time_seconds?: number | null;
}

/**
 * When the person made the save. Bringing in team updates replays unsent
 * saves on top, which sets their recorded (committer) time to now; the
 * author time keeps the original moment.
 */
export function savedAtSeconds(version: SaveTimes): number {
  return version.author_time_seconds ?? version.time_seconds;
}
