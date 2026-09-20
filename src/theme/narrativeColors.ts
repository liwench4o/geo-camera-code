import { blue, cyan, green, magenta, orange, purple } from '@ant-design/colors';
import type { CSSProperties } from 'react';
import type { NarrativePurpose } from '../camera/types';

export type NarrativeColorCategory = Exclude<NarrativePurpose, 'basic'> | 'transition';

export interface NarrativeColorConfig {
  category: NarrativeColorCategory | 'default';
  label: string;
  tagColor: string;
  background: string;
  track: string;
  swatch: string;
  border: string;
  progress: string;
  text: string;
}

type NarrativeColorStyle = CSSProperties & {
  '--narrative-color-background': string;
  '--narrative-color-border': string;
  '--narrative-color-progress': string;
  '--narrative-color-swatch': string;
  '--narrative-color-text': string;
  '--narrative-color-track': string;
};

const DEFAULT_COLOR_CONFIG: NarrativeColorConfig = {
  category: 'default',
  label: 'Undefined',
  tagColor: 'default',
  background: '#ffffff',
  track: '#f0f0f0',
  swatch: '#f0f0f0',
  border: '#f0f0f0',
  progress: '#f0f0f0',
  text: 'rgba(0, 0, 0, 0.88)',
};

export const NARRATIVE_COLOR_CONFIG: Record<NarrativeColorCategory, NarrativeColorConfig> = {
  emphasis: {
    category: 'emphasis',
    label: 'Emphasis',
    tagColor: 'magenta',
    background: magenta[0],
    track: magenta[1],
    swatch: magenta[2],
    border: magenta[2],
    progress: magenta[2],
    text: magenta[6],
  },
  overview: {
    category: 'overview',
    label: 'Overview',
    tagColor: 'orange',
    background: orange[0],
    track: orange[1],
    swatch: orange[2],
    border: orange[2],
    progress: orange[2],
    text: orange[6],
  },
  comparison: {
    category: 'comparison',
    label: 'Comparison',
    tagColor: 'green',
    background: green[0],
    track: green[1],
    swatch: green[2],
    border: green[2],
    progress: green[2],
    text: green[6],
  },
  supplement: {
    category: 'supplement',
    label: 'Supplement',
    tagColor: 'cyan',
    background: cyan[0],
    track: cyan[1],
    swatch: cyan[2],
    border: cyan[2],
    progress: cyan[2],
    text: cyan[6],
  },
  dynamic: {
    category: 'dynamic',
    label: 'Dynamic',
    tagColor: 'purple',
    background: purple[0],
    track: purple[1],
    swatch: purple[2],
    border: purple[2],
    progress: purple[2],
    text: purple[6],
  },
  transition: {
    category: 'transition',
    label: 'Transition',
    tagColor: 'blue',
    background: blue[0],
    track: blue[1],
    swatch: blue[2],
    border: blue[2],
    progress: blue[2],
    text: blue[6],
  },
};

export const NARRATIVE_COLOR_LEGEND_ITEMS: NarrativeColorConfig[] = [
  NARRATIVE_COLOR_CONFIG.emphasis,
  NARRATIVE_COLOR_CONFIG.overview,
  NARRATIVE_COLOR_CONFIG.comparison,
  NARRATIVE_COLOR_CONFIG.supplement,
  NARRATIVE_COLOR_CONFIG.dynamic,
  DEFAULT_COLOR_CONFIG,
  NARRATIVE_COLOR_CONFIG.transition,
];

function isNarrativeColorCategory(category: string | undefined): category is NarrativeColorCategory {
  return Boolean(category && category in NARRATIVE_COLOR_CONFIG);
}

function toDisplayLabel(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function getNarrativeColorConfig(category?: string) {
  return isNarrativeColorCategory(category) ? NARRATIVE_COLOR_CONFIG[category] : DEFAULT_COLOR_CONFIG;
}

export function getNarrativeLabel(category?: string) {
  if (isNarrativeColorCategory(category)) {
    return NARRATIVE_COLOR_CONFIG[category].label;
  }

  return category ? toDisplayLabel(category) : DEFAULT_COLOR_CONFIG.label;
}

export function getNarrativeTagColor(category?: string) {
  return getNarrativeColorConfig(category).tagColor;
}

export function getNarrativeProgressColor(category?: string) {
  return getNarrativeColorConfig(category).progress;
}

export function getNarrativeColorStyle(category?: string): NarrativeColorStyle {
  const config = getNarrativeColorConfig(category);
  return {
    '--narrative-color-background': config.background,
    '--narrative-color-border': config.border,
    '--narrative-color-progress': config.progress,
    '--narrative-color-swatch': config.swatch,
    '--narrative-color-text': config.text,
    '--narrative-color-track': config.track,
  };
}

export function getNarrativeButtonClassName(isActive = false) {
  return isActive ? 'narrative-color-button narrative-color-button-active' : 'narrative-color-button';
}

export function getNarrativeSliderClassName(category?: string) {
  void category;
  return 'narrative-slider';
}
