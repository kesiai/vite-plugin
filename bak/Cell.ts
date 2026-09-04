import React, { useRef } from 'react';
// import { useNodeProps } from '../services/atoms';

interface CellProps {
  nodeId: string;
  children: React.ReactElement;
}

/**
 * Cell 组件 - 使用 atom 实现精确的局部热更新
 *
 * 工作原理：
 * 1. 使用 useNodeProps(nodeId) 订阅该节点的独立 atom
 * 2. 只有该节点的 props 变化时，这个 Cell 才会重新渲染
 * 3. 其他节点的属性变化不会影响这个 Cell
 *
 * 这样实现了真正的局部更新！
 */
export const Cell: React.FunctionComponent<CellProps> = ({ nodeId, children }) => {
  // // 订阅该节点的独立 props atom
  // const [nodeProps, setNodeProp ] = useNodeProps(nodeId);

  // // 使用 ref 避免 children 变化导致不必要的重新渲染
  // const childrenRef = useRef(children);
  // if (childrenRef.current !== children) {
  //   childrenRef.current = children;
  // }

  // if(nodeProps === undefined) {
  //   setNodeProp({
  //     ...childrenRef.current.props ,
  //     'data-node-id': nodeId
  //   });
  //   return null;
  // }

  // 克隆子组件并传入合并后的 props
  return React.cloneElement(children, children.props as any /*...nodeProps*/ );
};
