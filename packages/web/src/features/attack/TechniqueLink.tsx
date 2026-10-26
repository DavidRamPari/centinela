import { useAttackIndex } from '../../lib/attack';
import { techniqueUrl } from '../../lib/links';
import { ExternalLink } from '../../components/ui/ExternalLink';

/** Technique id (and its official English name once the ATT&CK data is loaded), linked to attack.mitre.org. */
export function TechniqueLink({ id }: { id: string }) {
  const index = useAttackIndex();
  const info = index.data?.technique(id);
  return (
    <ExternalLink href={info?.url ?? techniqueUrl(id)}>
      <span className="font-mono">{id}</span>
      {info ? <span className="text-fg"> {info.name}</span> : null}
    </ExternalLink>
  );
}

/** Tactic shortnames as their official names. */
export function TacticNames({ tactics }: { tactics: readonly string[] }) {
  const index = useAttackIndex();
  return (
    <span className="text-muted">
      {tactics.map((tactic) => index.data?.tactic(tactic)?.name ?? tactic).join(', ')}
    </span>
  );
}
