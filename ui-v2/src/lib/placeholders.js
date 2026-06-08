// PLACEHOLDER content for Stage 1 only — static strings to give the shell a real
// shape and feel. NONE of this is read from app-data.json (that wiring is Stage 2).
// Kept obviously generic so it can't be mistaken for live model output.

export const GROUP_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

// Two teams per group for a believable team switcher. host: can | mex | usa (host-nation tint).
export const PLACEHOLDER_TEAMS = [
  { code: "MEX", name: "Mexico", nickname: "El Tri", group: "A", host: "mex" },
  { code: "KOR", name: "South Korea", nickname: "Taegeuk Warriors", group: "A", host: null },
  { code: "CAN", name: "Canada", nickname: "Les Rouges", group: "B", host: "can" },
  { code: "BIH", name: "Bosnia and Herzegovina", nickname: "The Dragons · Zmajevi", group: "B", host: null },
  { code: "USA", name: "United States", nickname: "USMNT", group: "C", host: "usa" },
  { code: "ENG", name: "England", nickname: "Three Lions", group: "C", host: null },
  { code: "ARG", name: "Argentina", nickname: "La Albiceleste", group: "D", host: null },
  { code: "CRO", name: "Croatia", nickname: "Vatreni", group: "D", host: null },
  { code: "FRA", name: "France", nickname: "Les Bleus", group: "E", host: null },
  { code: "SEN", name: "Senegal", nickname: "Lions of Teranga", group: "E", host: null },
  { code: "BRA", name: "Brazil", nickname: "Seleção", group: "F", host: null },
  { code: "POR", name: "Portugal", nickname: "Seleção das Quinas", group: "F", host: null },
  { code: "ESP", name: "Spain", nickname: "La Roja", group: "G", host: null },
  { code: "URU", name: "Uruguay", nickname: "La Celeste", group: "G", host: null },
  { code: "GER", name: "Germany", nickname: "Die Mannschaft", group: "H", host: null },
  { code: "JPN", name: "Japan", nickname: "Samurai Blue", group: "H", host: null },
  { code: "NED", name: "Netherlands", nickname: "Oranje", group: "I", host: null },
  { code: "MAR", name: "Morocco", nickname: "Atlas Lions", group: "I", host: null },
  { code: "BEL", name: "Belgium", nickname: "Red Devils", group: "J", host: null },
  { code: "COL", name: "Colombia", nickname: "Los Cafeteros", group: "J", host: null },
  { code: "SUI", name: "Switzerland", nickname: "La Nati", group: "K", host: null },
  { code: "ECU", name: "Ecuador", nickname: "La Tri", group: "K", host: null },
  { code: "NOR", name: "Norway", nickname: "Løvene", group: "L", host: null },
  { code: "AUS", name: "Australia", nickname: "Socceroos", group: "L", host: null },
];

// Default selected team matches the brief's example.
export const DEFAULT_TEAM_CODE = "BIH";

// Placeholder match-day groupings for the Matches view.
export const PLACEHOLDER_MATCHDAYS = [
  { label: "Today", count: 3 },
  { label: "Tomorrow", count: 4 },
  { label: "Thu, Jun 11", count: 3 },
];
