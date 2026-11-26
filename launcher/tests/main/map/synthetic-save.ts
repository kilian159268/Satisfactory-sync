/**
 * Baut mit dem Writer von @etothepii/satisfactory-file-parser einen kleinen, echten
 * Spielstand (Binärformat), damit der Lesepfad ohne Save der Gruppe getestet werden kann.
 * Das Format ist das einer U8-Version (saveVersion 46), nicht das aktuelle der Gruppe.
 */
import {
  CompressionAlgorithmCode,
  Parser,
  SatisfactorySave,
  SaveEntity,
} from '@etothepii/satisfactory-file-parser';

export interface SyntheticObject {
  typePath: string;
  name: string;
  x: number;
  y: number;
}

export function buildSyntheticSave(
  objects: readonly SyntheticObject[],
  mutateBody?: (body: Uint8Array) => void,
): Uint8Array {
  const header = {
    saveHeaderType: 13,
    saveVersion: 46,
    buildVersion: 365306,
    mapName: 'Persistent_Level',
    mapOptions: '',
    sessionName: 'Test',
    playDurationSeconds: 10,
    saveDateTime: '1700000000000',
    sessionVisibility: 0,
    fEditorObjectVersion: 40,
    rawModMetadataString: '',
    isModdedSave: 0,
    saveIdentifier: 'test',
    partitionEnabledFlag: true,
    consistencyHashBytes: { isValid: false },
    creativeModeEnabled: false,
  };
  const save = new SatisfactorySave('Test', header);
  save.saveBodyValidation = {
    version: 0,
    grids: {},
  } as unknown as SatisfactorySave['saveBodyValidation'];
  const entities = objects.map((o) => {
    const e = new SaveEntity(
      o.typePath,
      'Persistent_Level',
      `Persistent_Level:PersistentLevel.${o.name}`,
      '',
      true,
    );
    e.transform = {
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      translation: { x: o.x, y: o.y, z: 0 },
      scale3d: { x: 1, y: 1, z: 1 },
    };
    e.properties = {};
    e.wasPlacedInLevel = false;
    e.parentObject = { levelName: '', pathName: '' };
    e.components = [];
    return e;
  });
  save.levels = {
    Persistent_Level: {
      name: 'Persistent_Level',
      objects: entities,
      collectables: [],
      writesDestroyedActorsInTOCBlob: false,
    },
  };
  save.compressionInfo = {
    chunkHeaderVersion: 0x22222222,
    packageFileTag: 0x9e2a83c1,
    maxUncompressedChunkContentSize: 131072,
    compressionAlgorithm: CompressionAlgorithmCode.ZLIB,
  };
  let head: Uint8Array = new Uint8Array();
  const chunks: Uint8Array[] = [];
  Parser.WriteSave(
    save,
    (h) => {
      head = h;
    },
    (c) => {
      chunks.push(c);
    },
    {
      onBinaryBeforeCompressing: (body) => {
        mutateBody?.(new Uint8Array(body));
      },
    },
  );
  return Buffer.concat([head, ...chunks]);
}
