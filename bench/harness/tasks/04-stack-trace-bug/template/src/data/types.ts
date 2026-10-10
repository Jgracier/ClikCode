export interface Ticket {
  id: string;
  title: string;
  /** Tickets imported from the old tracker (ids starting "OLD-") have none. */
  tags?: string[];
  openedAt: string;
}
