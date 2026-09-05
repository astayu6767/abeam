export type BotStatus = "offline" | "connecting" | "online" | "error";

export type BotItem = {
  id: string;
  name: string;
  username: string | null;
  host: string;
  port: number;
  version: string;
  proxy: string;
  ytChannel: string;
  beamIp: string;
  discordUser: string;
  engine: string;
  beamType: string;
  spamMessage: string;
  spamInterval: number;
  spamTriggerWord: string;
  spamReplyMessage: string;
  openerScript: string;
  status: BotStatus;
  joined: boolean;
  lastError: string | null;
  createdAt: string;
};

export type LogEntry = {
  ts: number;
  level: "info" | "chat" | "error" | "system";
  line: string;
};

export type HotbarItem = {
  slot: number;
  name: string | null;
  displayName: string | null;
  count: number;
  selected: boolean;
};

export type ViewEntity = {
  name: string;
  type: string;
  kind: "player" | "mob" | "object" | "other";
  forward: number;
  right: number;
  dy: number;
  distance: number;
  bearing: number;
};

export type ViewSnapshot = {
  available: boolean;
  username?: string;
  position?: { x: number; y: number; z: number };
  yaw?: number;
  pitch?: number;
  facing?: string;
  health?: number;
  food?: number;
  dimension?: string;
  timeOfDay?: number;
  isDay?: boolean;
  heldItem?: string | null;
  lookingAt?: { name: string; x: number; y: number; z: number } | null;
  entities?: ViewEntity[];
  nearbyBlocks?: { name: string; forward: number; right: number; dy: number }[];
  hotbar?: HotbarItem[];
  selectedSlot?: number;
  using?: boolean;
  window?: {
    title: string;
    slots: (HotbarItem | null)[];
  } | null;
};
