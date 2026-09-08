'use client';

import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleDot,
  LoaderCircle,
  Mail,
  Pencil,
  Plus,
  UserRound,
  Users,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { LobbyBoardOverview } from '@/components/lobby-board-overview';
import type { GameMode, X01Rule } from '@/lib/game-engine';
import type { PlayerProfile } from '@/lib/player-profiles';

type SetupDetails = {
  mode: GameMode;
  inRule: X01Rule;
  outRule: X01Rule;
};

const gameCopy: Record<GameMode, { title: string; eyebrow: string; description: string }> = {
  '501': {
    title: '501',
    eyebrow: 'The standard',
    description: 'Race down from 501 and finish on the exact checkout.',
  },
  '301': {
    title: '301',
    eyebrow: 'Quick leg',
    description: 'A faster countdown with the same familiar in and out rules.',
  },
  cricket: {
    title: 'Cricket',
    eyebrow: 'Close the board',
    description: 'Own 15 through 20 and Bull while keeping the points advantage.',
  },
};

export function GameLobby({
  boardHost,
  profiles,
  selectedIds,
  profilesLoading,
  profileError,
  onChooseGame,
  onOpenBoard,
  onOpenStats,
  onSaveProfile,
  onTogglePlayer,
}: {
  boardHost: string;
  profiles: PlayerProfile[];
  selectedIds: string[];
  profilesLoading: boolean;
  profileError: string | null;
  onChooseGame: (mode: GameMode) => void;
  onOpenBoard: () => void;
  onOpenStats: () => void;
  onSaveProfile: (profile: { id?: string; name: string; email: string }) => Promise<void>;
  onTogglePlayer: (id: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);

  const editProfile = (profile?: PlayerProfile) => {
    setEditingId(profile?.id);
    setName(profile?.name || '');
    setEmail(profile?.email || '');
    setFormOpen(true);
  };

  const saveProfile = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSaveProfile({ id: editingId, name: name.trim(), email: email.trim() });
      setFormOpen(false);
      setEditingId(undefined);
      setName('');
      setEmail('');
    } catch {
      // The parent keeps the actionable server error visible beside the form.
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="lobby-page">
      <div className="lobby-heading">
        <div>
          <p className="eyebrow">Match lobby</p>
          <h1>Who&apos;s at the oche?</h1>
          <p>Choose the lineup once, then move through as many games as you like.</p>
        </div>
        <div className="lineup-summary"><Users /><strong>{selectedIds.length}</strong><span>selected</span></div>
      </div>

      <LobbyBoardOverview boardHost={boardHost} onOpenBoard={onOpenBoard} onOpenStats={onOpenStats} />

      <div className="lobby-grid">
        <section className="lobby-card player-roster-card">
          <div className="lobby-card-heading">
            <div><p className="eyebrow">Your players</p><h2>Lineup</h2></div>
            <span>{selectedIds.length}/4</span>
          </div>
          <p className="lobby-card-copy">Profiles and email addresses are saved on this board, so every browser connected to it sees the same players and history.</p>

          <div className="profile-list" aria-label="Saved players">
            {profilesLoading && !profiles.length ? (
              <div className="profile-empty"><LoaderCircle className="is-spinning" /> Loading players…</div>
            ) : profiles.map((profile) => {
              const selected = selectedIds.includes(profile.id);
              return (
                <div className={`profile-row ${selected ? 'is-selected' : ''}`} key={profile.id}>
                  <button
                    aria-pressed={selected}
                    className="profile-select"
                    onClick={() => onTogglePlayer(profile.id)}
                    type="button"
                  >
                    <span className="profile-avatar">{selected ? <Check /> : profile.name.slice(0, 1).toUpperCase()}</span>
                    <span className="profile-identity">
                      <strong>{profile.name}</strong>
                      <small>{profile.email || 'No email yet'} · {profile.games} {profile.games === 1 ? 'game' : 'games'}</small>
                    </span>
                  </button>
                  <button aria-label={`Edit ${profile.name}`} className="profile-edit" onClick={() => editProfile(profile)} type="button"><Pencil /></button>
                </div>
              );
            })}
            {!profilesLoading && !profiles.length && !profileError && (
              <div className="profile-empty"><UserRound /> Add the first player for this board.</div>
            )}
          </div>

          {profileError && <p className="profile-error">{profileError}</p>}

          {formOpen ? (
            <div className="profile-form">
              <div className="profile-form-heading"><strong>{editingId ? 'Edit player' : 'Add player'}</strong><span>Saved to this board</span></div>
              <Input aria-label="Player name" onChange={(event) => setName(event.target.value)} placeholder="Player name" value={name} />
              <div className="email-input"><Mail /><Input aria-label="Player email" onChange={(event) => setEmail(event.target.value)} placeholder="Email (optional)" type="email" value={email} /></div>
              <div className="profile-form-actions">
                <Button onClick={() => setFormOpen(false)} type="button" variant="ghost">Cancel</Button>
                <Button disabled={saving || !name.trim()} onClick={() => void saveProfile()} type="button">{saving && <LoaderCircle className="is-spinning" />} Save player</Button>
              </div>
            </div>
          ) : (
            <Button className="add-profile-button" onClick={() => editProfile()} type="button" variant="outline"><Plus /> Add player</Button>
          )}
        </section>

        <section className="lobby-card game-catalog-card">
          <div className="lobby-card-heading">
            <div><p className="eyebrow">Choose a game</p><h2>What are we playing?</h2></div>
            <CircleDot />
          </div>
          <p className="lobby-card-copy">Pick a format, confirm its rules, then start with the lineup on the left.</p>
          <div className="game-catalog">
            {(['501', '301', 'cricket'] as GameMode[]).map((mode) => (
              <button disabled={!selectedIds.length} key={mode} onClick={() => onChooseGame(mode)} type="button">
                <span className="game-catalog-number">{mode === 'cricket' ? '×' : mode}</span>
                <span><small>{gameCopy[mode].eyebrow}</small><strong>{gameCopy[mode].title}</strong><p>{gameCopy[mode].description}</p></span>
                <ChevronRight />
              </button>
            ))}
          </div>
          {!selectedIds.length && <p className="game-disabled-hint">Select at least one player to choose a game.</p>}
        </section>
      </div>
    </section>
  );
}

export function GameDetails({
  boardHost,
  setup,
  selectedPlayers,
  onBack,
  onChange,
  onStart,
}: {
  boardHost: string;
  setup: SetupDetails;
  selectedPlayers: PlayerProfile[];
  onBack: () => void;
  onChange: (change: Partial<SetupDetails>) => void;
  onStart: () => void;
}) {
  const copy = gameCopy[setup.mode];
  return (
    <section className="game-details-page">
      <button className="details-back" onClick={onBack} type="button"><ArrowLeft /> Players & games</button>
      <div className="game-details-grid">
        <section className="lobby-card game-rules-card">
          <p className="eyebrow">Game details</p>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
          <div className="selected-lineup">
            <span>Lineup</span>
            {selectedPlayers.map((player, index) => <strong key={player.id}>{index + 1}. {player.name}</strong>)}
          </div>
          {setup.mode !== 'cricket' && (
            <div className="settings-row">
              <div>
                <label htmlFor="in-rule">Start</label>
                <NativeSelect id="in-rule" onChange={(event) => onChange({ inRule: event.target.value as X01Rule })} value={setup.inRule}>
                  <NativeSelectOption value="straight">Straight in</NativeSelectOption>
                  <NativeSelectOption value="double">Double in</NativeSelectOption>
                </NativeSelect>
              </div>
              <div>
                <label htmlFor="out-rule">Finish</label>
                <NativeSelect id="out-rule" onChange={(event) => onChange({ outRule: event.target.value as X01Rule })} value={setup.outRule}>
                  <NativeSelectOption value="double">Double out</NativeSelectOption>
                  <NativeSelectOption value="straight">Straight out</NativeSelectOption>
                </NativeSelect>
              </div>
            </div>
          )}
          <Button className="start-button" disabled={!selectedPlayers.length} onClick={onStart} size="lg"><Users /> Start game</Button>
        </section>

        <section className="game-details-preview">
          <div className="game-preview-orbit"><CircleDot /></div>
          <p className="preview-kicker">Ready at the oche</p>
          <h2>{copy.title}</h2>
          <p>{selectedPlayers.map((player) => player.name).join(' · ')}</p>
          <span>{boardHost}:13520</span>
        </section>
      </div>
    </section>
  );
}
