/**
 * Shared mutable timeline. The single source of truth for the edit state.
 * Agents read it, mutate it, and render it.
 */

export type Clip = {
  id: string;
  sourceUri: string;
  videoStart: number; // seconds
  videoEnd: number;   // seconds
  position: number;   // position on the output timeline in seconds
};

export type AudioTrack = {
  sourceUri: string;
  start: number;      // start offset in source audio
  duration: number;   // duration to play
};

export type TimelineState = {
  clips: Clip[];
  audio: AudioTrack | null;
  version: number;
};

let state: TimelineState = {
  clips: [],
  audio: null,
  version: 0,
};

let clipCounter = 0;

export function reset(): TimelineState {
  state = { clips: [], audio: null, version: state.version + 1 };
  clipCounter = 0;
  return state;
}

export function addClip(sourceUri: string, videoStart: number, videoEnd: number, position: number): Clip {
  if (videoEnd <= videoStart) {
    throw new Error(
      `Clip has non-positive duration: videoStart=${videoStart}, videoEnd=${videoEnd}. videoEnd must be strictly greater than videoStart.`
    );
  }
  if (videoStart < 0) {
    throw new Error(`Clip videoStart must be non-negative, got ${videoStart}.`);
  }
  if (position < 0) {
    throw new Error(`Clip position must be non-negative, got ${position}.`);
  }

  const clip: Clip = {
    id: `clip_${++clipCounter}`,
    sourceUri,
    videoStart,
    videoEnd,
    position,
  };
  state.clips.push(clip);
  state.clips.sort((a, b) => a.position - b.position);
  state.version++;
  return clip;
}

export function setAudio(sourceUri: string, start: number, duration: number): AudioTrack {
  state.audio = { sourceUri, start, duration };
  state.version++;
  return state.audio;
}

export function get(): TimelineState {
  return state;
}

export function toJSON() {
  return {
    version: state.version,
    audio: state.audio,
    clips: state.clips,
    totalDuration: state.clips.reduce(
      (max, c) => Math.max(max, c.position + (c.videoEnd - c.videoStart)),
      0
    ),
  };
}
