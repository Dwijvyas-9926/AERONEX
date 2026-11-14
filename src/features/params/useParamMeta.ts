import { useEffect, useState } from "react";
import { loadMeta, metaVersionFor, type MetaSet, type MetaVersion } from "../../mavlink/paramMeta";
import { useParams } from "../../state/paramStore";

/**
 * The parameter definitions that fit the linked aircraft's firmware, loaded
 * on first use. `meta` is null while loading or if the file could not be
 * fetched; pages still work, just without descriptions.
 */
export function useParamMeta(): { meta: MetaSet | null; version: MetaVersion; failed: boolean } {
  const version = useParams((s) => metaVersionFor(s.values));
  const [state, setState] = useState<{ version: MetaVersion; meta: MetaSet | null; failed: boolean }>({ version, meta: null, failed: false });

  useEffect(() => {
    let live = true;
    loadMeta(version).then(
      (meta) => live && setState({ version, meta, failed: false }),
      () => live && setState({ version, meta: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [version]);

  const current = state.version === version;
  return { meta: current ? state.meta : null, version, failed: current && state.failed };
}
