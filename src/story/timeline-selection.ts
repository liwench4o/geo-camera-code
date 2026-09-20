export interface ClickOnlySelectionHandlers {
  onClick: () => void;
}

export function getClickOnlySelectionHandlers(onSelect: () => void): ClickOnlySelectionHandlers {
  return { onClick: onSelect };
}
