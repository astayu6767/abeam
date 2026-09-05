// Plan definitions. Price is in USD; the LTC amount is derived at invoice
// time from a configurable rate (see config.js LTC_USD_RATE).
// Everything here is operator-editable — edit + restart.
export const PLANS = [
  {
    id: 'ace',
    name: 'Ace',
    priceUsd: 5,
    botSlots: 1,
    servers: 1,
    targets: -1, // unlimited
    ai: false,
    priority: 'standard',
    monthlyCredits: 0,
    tagline: 'One clean shot.',
    features: ['1 managed bot slot', 'Any Minecraft server', 'Unlimited targets', 'Keyword replies', 'Live console'],
  },
  {
    id: 'raid',
    name: 'Raid',
    priceUsd: 8,
    botSlots: 4,
    servers: 4,
    targets: -1, // unlimited
    ai: true,
    priority: 'priority',
    monthlyCredits: 500,
    tagline: 'The crew that grinds brackets.',
    features: ['4 managed bot slots', 'Any Minecraft server', 'Unlimited targets', 'Beam AI rewrites', 'Advanced conversation flow', 'Priority queue', 'Live console per bot'],
    popular: true,
  },
  {
    id: 'storm',
    name: 'Storm',
    priceUsd: 16,
    botSlots: 12,
    servers: 12,
    targets: -1, // unlimited
    ai: true,
    priority: 'priority',
    monthlyCredits: 2500,
    tagline: 'Flood the whole lobby.',
    features: ['12 managed bot slots', 'Any Minecraft server', 'Unlimited targets', 'Beam AI rewrites', 'Custom persona + scripts', 'Priority support', 'API + webhooks'],
  },
  {
    id: 'titan',
    name: 'Titan',
    priceUsd: 0, // custom
    custom: true,
    botSlots: 0,
    servers: 0,
    monthlyCredits: -1,
    tagline: 'Dedicated cluster for orgs.',
    features: ['Dedicated bot cluster', 'SLA + priority support', 'White-label dashboard', 'Custom integrations'],
  },
];

export const planById = (id) => PLANS.find((p) => p.id === id);
export const paidPlans = () => PLANS.filter((p) => !p.custom);