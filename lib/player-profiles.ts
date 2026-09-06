export const PLAYER_SELECTION_STORAGE_KEY = 'opendartboard-player-selection-v1';

export type PlayerProfile = {
  id: string;
  name: string;
  email: string | null;
  games: number;
  lastPlayed: string | null;
};

export function parsePlayerSelection(value: string | null) {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .slice(0, 4);
  } catch {
    return [];
  }
}

export function reconcilePlayerSelection(
  savedIds: string[],
  profiles: PlayerProfile[],
  maximum = 4,
) {
  const available = new Set(profiles.map((profile) => profile.id));
  return savedIds.filter((id) => available.has(id)).slice(0, maximum);
}
