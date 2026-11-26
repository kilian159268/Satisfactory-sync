/**
 * Klassennamen und Pfade aus Satisfactory-Spielständen, die der Karten-Generator auswertet.
 *
 * Annahme – mit echtem Save prüfen (Plan Kapitel 14). Die Listen stammen aus den bekannten
 * Pfaden der Spielversion 1.x (u. a. aus den Konstanten von @etothepii/satisfactory-file-parser)
 * und sind nicht gegen einen Spielstand der Gruppe geprüft.
 */

/** Präfix der Fabrikgebäude (Maschinen, Generatoren, Extraktoren, Lager …). */
export const FACTORY_PATH_PREFIX = '/Game/FactoryGame/Buildable/Factory/';

/** Bahnhof (ohne Güter-/Flüssigkeitsbahnsteige). */
export const TRAIN_STATION_CLASS = 'Build_TrainStation_C';

/** Hält den Namen eines Bahnhofs (`mStationName`) und verweist per `mStation` auf ihn. */
export const TRAIN_STATION_IDENTIFIER_PATH = '/Script/FactoryGame.FGTrainStationIdentifier';

/** Spielerfigur; die Position ist die letzte bekannte Position des Spielers. */
export const PLAYER_CLASS = 'Char_Player_C';

/** PlayerState: trägt in manchen Versionen den Namen (`mCachedPlayerName`) und `mOwnedPawn`. */
export const PLAYER_STATE_CLASS = 'BP_PlayerState_C';

/**
 * Unter {@link FACTORY_PATH_PREFIX} liegen auch Logistik und Deko, die für die Karte nur
 * Rauschen sind: Förderbänder, Rohre, Kabel, Masten, Schienen, Lampen, Schilder.
 * Fundamente, Wände, Treppen usw. liegen unter `/Buildable/Building/` und fallen schon durch
 * das Präfix heraus; die Muster unten fangen sie zusätzlich ab, falls ein Pfad abweicht.
 */
export const EXCLUDED_CLASS_PATTERNS: readonly RegExp[] = [
  /^Build_Conveyor/, // Bänder, Lifte, Stützen, Splitter/Merger (ConveyorAttachment…)
  /^Build_Pipeline/, // Rohre, Stützen, Kreuzungen, Pumpen
  /^Build_PipeSupport/,
  /^Build_PipeHyper/, // Hypertubes
  /^Build_Hyper/,
  /^Build_Valve/,
  /^Build_PowerLine/, // Kabel
  /^Build_PowerPole/, // Masten, Wandsteckdosen
  /^Build_PowerTower/,
  /^Build_PowerSwitch/,
  /^Build_PriorityPowerSwitch/,
  /^Build_Railroad/, // Schienen, Signale, Prellböcke
  /^Build_Train/, // Bahnhof (eigene Liste), Bahnsteige
  /^Build_Foundation/,
  /^Build_Wall/,
  /^Build_Ramp/,
  /^Build_Roof/,
  /^Build_Beam/,
  /^Build_Pillar/,
  /^Build_Frame/,
  /^Build_Window/,
  /^Build_Door/,
  /^Build_Gate/,
  /^Build_Fence/,
  /^Build_Railing/,
  /^Build_Barrier/,
  /^Build_Stair/,
  /^Build_Ladder/,
  /^Build_Walkway/,
  /^Build_Catwalk/,
  /^Build_Light/,
  /^Build_CeilingLight/,
  /^Build_StreetLight/,
  /^Build_FloodlightPole/,
  /^Build_Sign/,
  /^Build_StandaloneSign/,
  /^Build_JumpPad/,
  /^Build_LandingPad/,
  /^Build_Xmass/,
  /^Build_Snow/,
];

/**
 * Deutsche Kurznamen, nur wo der Name im Spiel sicher bekannt ist. Alles andere bekommt den
 * aufbereiteten Klassennamen (siehe `readableTypeName`).
 */
export const GERMAN_NAMES: Readonly<Record<string, string>> = {
  Build_ConstructorMk1_C: 'Konstruktor',
  Build_AssemblerMk1_C: 'Monteur',
  Build_ManufacturerMk1_C: 'Fertiger',
  Build_SmelterMk1_C: 'Schmelzofen',
  Build_FoundryMk1_C: 'Gießerei',
  Build_OilRefinery_C: 'Raffinerie',
  Build_Packager_C: 'Abfüller',
  Build_Blender_C: 'Mischer',
  Build_HadronCollider_C: 'Teilchenbeschleuniger',
  Build_MinerMk1_C: 'Miner Mk.1',
  Build_MinerMk2_C: 'Miner Mk.2',
  Build_MinerMk3_C: 'Miner Mk.3',
  Build_WaterPump_C: 'Wasserextraktor',
  Build_OilPump_C: 'Ölpumpe',
  Build_GeneratorBiomass_C: 'Biomassekraftwerk',
  Build_GeneratorBiomass_Automated_C: 'Biomassekraftwerk',
  Build_GeneratorCoal_C: 'Kohlekraftwerk',
  Build_GeneratorFuel_C: 'Treibstoffkraftwerk',
  Build_GeneratorNuclear_C: 'Atomkraftwerk',
  Build_GeneratorGeoThermal_C: 'Geothermiekraftwerk',
  Build_PowerStorageMk1_C: 'Stromspeicher',
  Build_StorageContainerMk1_C: 'Lagercontainer',
  Build_StorageContainerMk2_C: 'Industrie-Lagercontainer',
  Build_PipeStorageTank_C: 'Flüssigkeitspuffer',
  Build_IndustrialTank_C: 'Industrie-Flüssigkeitspuffer',
  Build_HubTerminal_C: 'HUB',
  Build_TradingPost_C: 'HUB',
  Build_SpaceElevator_C: 'Weltraumaufzug',
  Build_DroneStation_C: 'Drohnenport',
  Build_TruckStation_C: 'LKW-Station',
  Build_ResourceSink_C: 'AWESOME-Sink',
  Build_ResourceSinkShop_C: 'AWESOME-Shop',
  Build_RadarTower_C: 'Radarturm',
  Build_Mam_C: 'M.A.M.',
};

/**
 * Ausdehnung der Spielwelt in Metern für eine leere Karte (keine Gebäude, keine Spieler).
 * Annahme – mit echtem Save prüfen (Plan Kapitel 14).
 */
export const WORLD_BOUNDS_M = { minX: -3247, minY: -3750, maxX: 4253, maxY: 3750 } as const;

/** Klassenname aus einem Typpfad, z. B. `/…/Build_X.Build_X_C` → `Build_X_C`. */
export function className(typePath: string): string {
  const dot = typePath.lastIndexOf('.');
  if (dot >= 0) return typePath.slice(dot + 1);
  const slash = typePath.lastIndexOf('/');
  return slash >= 0 ? typePath.slice(slash + 1) : typePath;
}

/** Fabrikgebäude, das auf der Karte gezählt wird. */
export function isMapBuilding(typePath: string): boolean {
  if (!typePath.startsWith(FACTORY_PATH_PREFIX)) return false;
  const name = className(typePath);
  return !EXCLUDED_CLASS_PATTERNS.some((pattern) => pattern.test(name));
}

/** Lesbarer Name: deutscher Kurzname oder aufbereiteter Klassenname (`Build_FooBarMk2_C` → `Foo Bar Mk.2`). */
export function readableTypeName(typePath: string): string {
  const name = className(typePath);
  const german = GERMAN_NAMES[name];
  if (german) return german;
  const core = name.replace(/^Build_/, '').replace(/_C$/, '');
  const spaced = core
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\bMk\s?(\d+)/gi, 'Mk.$1')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced.length > 0 ? spaced : name;
}

/**
 * Bodennahe Objekte, deren Höhe als Geländepunkt dient (Typpfad beginnt mit einem dieser Präfixe).
 * GEPRÜFT 2026-11-26 an einem echten Save (Build 520140): ~1.200 solcher Objekte über die ganze Welt
 * (Rohstoffvorkommen, Fracking, Geysire, Absturzstellen, Gefahren, Tiere, Fundstücke).
 * Gebäude, Fahrzeuge und Spieler zählen bewusst nicht (Fundamente, Fliegen, Jetpack).
 */
export const TERRAIN_SAMPLE_PREFIXES = [
  '/Game/FactoryGame/Resource/',
  '/Game/FactoryGame/World/Benefit/',
  '/Game/FactoryGame/World/Hazard/',
  '/Game/FactoryGame/Character/Creature/',
  '/Game/FactoryGame/Prototype/WAT/',
  '/Script/FactoryGame.FGItemPickup_Spawnable',
] as const;

export function isTerrainSample(typePath: string): boolean {
  return TERRAIN_SAMPLE_PREFIXES.some((p) => typePath.startsWith(p));
}

/** ANNAHME – mit dem echten Spiel prüfen (Plan Kapitel 14): Unter dieser Höhe (m) wird Wasser gezeichnet. */
export const TERRAIN_WATER_LEVEL_M = -20;
