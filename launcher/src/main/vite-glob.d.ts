/**
 * Typ für Vites `import.meta.glob` im Main-Prozess (tsconfig.node.json lädt `vite/client` nicht,
 * damit keine DOM-/Asset-Typen in den Node-Teil gelangen).
 */
interface ImportMeta {
  glob<T>(pattern: string): Record<string, () => Promise<T>>;
}
