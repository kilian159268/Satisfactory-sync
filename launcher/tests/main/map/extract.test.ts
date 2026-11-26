import { describe, expect, it } from 'vitest';
import { extractMapSources, type SaveLikeObject } from '../../../src/main/map/extract';

const STATION =
  '/Game/FactoryGame/Buildable/Factory/Train/Station/Build_TrainStation.Build_TrainStation_C';
const PLAYER = '/Game/FactoryGame/Character/Player/Char_Player.Char_Player_C';
const PLAYER_STATE = '/Game/FactoryGame/Character/Player/BP_PlayerState.BP_PlayerState_C';
const CONSTRUCTOR =
  '/Game/FactoryGame/Buildable/Factory/ConstructorMk1/Build_ConstructorMk1.Build_ConstructorMk1_C';

const at = (x: number, y: number) => ({ translation: { x, y, z: 0 } });

describe('extractMapSources', () => {
  it('liest Positionen, Bahnhofsnamen und Spielernamen', () => {
    const objects: SaveLikeObject[] = [
      {
        typePath: CONSTRUCTOR,
        instanceName: 'Persistent_Level:PersistentLevel.C1',
        transform: at(1, 2),
      },
      {
        typePath: STATION,
        instanceName: 'Persistent_Level:PersistentLevel.S1',
        transform: at(3, 4),
      },
      {
        typePath: STATION,
        instanceName: 'Persistent_Level:PersistentLevel.S2',
        transform: at(5, 6),
      },
      {
        typePath: '/Script/FactoryGame.FGTrainStationIdentifier',
        instanceName: 'Persistent_Level:PersistentLevel.Id1',
        properties: {
          mStation: {
            value: {
              levelName: 'Persistent_Level',
              pathName: 'Persistent_Level:PersistentLevel.S1',
            },
          },
          mStationName: { value: { flags: 0, historyType: 255, value: 'Kupferhütte' } },
        },
      },
      {
        typePath: '/Script/FactoryGame.FGTrainStationIdentifier',
        instanceName: 'Persistent_Level:PersistentLevel.Id2',
        properties: {
          mStation: { value: { pathName: 'Persistent_Level:PersistentLevel.S2' } },
          mStationName: { value: { flags: 0, historyType: 0, sourceText: { value: 'Ölfeld' } } },
        },
      },
      {
        typePath: PLAYER,
        instanceName: 'Persistent_Level:PersistentLevel.Char_Player_C_1',
        transform: at(7, 8),
        properties: { mCachedPlayerName: { value: 'Anna' } },
      },
      {
        typePath: PLAYER,
        instanceName: 'Persistent_Level:PersistentLevel.Char_Player_C_2',
        transform: at(9, 10),
      },
      {
        typePath: PLAYER_STATE,
        instanceName: 'Persistent_Level:PersistentLevel.BP_PlayerState_C_2',
        properties: {
          mOwnedPawn: { value: { pathName: 'Persistent_Level:PersistentLevel.Char_Player_C_2' } },
          mCachedPlayerName: { value: 'Ben' },
        },
      },
      {
        typePath: PLAYER,
        instanceName: 'Persistent_Level:PersistentLevel.Char_Player_C_3',
        transform: at(11, 12),
      },
      // Komponente ohne Position
      { typePath: '/Script/FactoryGame.FGInventoryComponent', instanceName: 'Inv' },
    ];
    const sources = extractMapSources({ levels: { Persistent_Level: { objects } } });
    expect(sources.objects).toEqual([
      { typePath: CONSTRUCTOR, x: 1, y: 2, z: 0 },
      { typePath: STATION, x: 3, y: 4, z: 0, name: 'Kupferhütte' },
      { typePath: STATION, x: 5, y: 6, z: 0, name: 'Ölfeld' },
    ]);
    expect(sources.players).toEqual([
      { name: 'Anna', x: 7, y: 8 },
      { name: 'Ben', x: 9, y: 10 },
      { name: undefined, x: 11, y: 12 },
    ]);
  });

  it('sammelt Objekte aus allen Levels', () => {
    const sources = extractMapSources({
      levels: {
        A: { objects: [{ typePath: CONSTRUCTOR, instanceName: 'a', transform: at(1, 1) }] },
        B: { objects: [{ typePath: CONSTRUCTOR, instanceName: 'b', transform: at(2, 2) }] },
      },
    });
    expect(sources.objects).toHaveLength(2);
  });

  it('übersteht unerwartete Property-Formen', () => {
    const sources = extractMapSources({
      levels: {
        L: {
          objects: [
            {
              typePath: PLAYER,
              instanceName: 'p',
              transform: at(0, 0),
              properties: { mCachedPlayerName: 42 },
            },
            {
              typePath: '/Script/FactoryGame.FGTrainStationIdentifier',
              instanceName: 'i',
              properties: { mStation: null, mStationName: 'kaputt' },
            },
          ],
        },
      },
    });
    expect(sources.players).toEqual([{ name: undefined, x: 0, y: 0 }]);
    expect(sources.objects).toEqual([]);
  });
});
