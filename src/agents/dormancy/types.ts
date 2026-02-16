export type DormancyState = {
  version: 1;
  dormant: boolean;
  updatedAt: string;        // ISO timestamp
  activatedAt: string | null; // cursor - messages before this are ignored
  changedBy: string | null;   // agent ID that triggered change
};
