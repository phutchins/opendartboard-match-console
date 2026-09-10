export const BOARD_OPERATION_EVENT = 'opendartboard:board-operation';

export type BoardOperation = {
  active: boolean;
  action: string;
  title: string;
  message: string;
};

export function announceBoardOperation(operation: BoardOperation) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<BoardOperation>(BOARD_OPERATION_EVENT, { detail: operation }));
}
