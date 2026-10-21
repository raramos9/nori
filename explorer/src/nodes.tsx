import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { EvidenceStatus } from '../../src/graph/model.js';

export type ScreenNodeData = {
  route: string;
  status: EvidenceStatus;
  selfLoops: number;
  dim: boolean;
  match: boolean;
};
export type GhostNodeData = { count: number; dim: boolean };

export type ScreenNodeType = Node<ScreenNodeData, 'screen'>;
export type GhostNodeType = Node<GhostNodeData, 'ghost'>;

export function ScreenNode({ data, selected }: NodeProps<ScreenNodeType>) {
  const classes = ['screen', `status-${data.status}`];
  if (selected) classes.push('selected');
  if (data.dim) classes.push('dim');
  if (data.match) classes.push('match');
  return (
    <div className={classes.join(' ')} title={`${data.route} (${data.status})`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="route">{data.route}</span>
      {data.selfLoops > 0 ? <span className="loops" title={`${data.selfLoops} links back to this screen`}>↺{data.selfLoops}</span> : null}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

export function GhostNode({ data, selected }: NodeProps<GhostNodeType>) {
  const classes = ['ghost'];
  if (selected) classes.push('selected');
  if (data.dim) classes.push('dim');
  return (
    <div className={classes.join(' ')} title="Navigation that static analysis could not resolve">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span>? {data.count} unresolved</span>
    </div>
  );
}

export const NODE_TYPES = { screen: ScreenNode, ghost: GhostNode };
