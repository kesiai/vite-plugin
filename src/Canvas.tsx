import { lazy, Suspense, useMemo, useState, useEffect, useRef } from 'react';

interface DragState {
  isDragging: boolean;
  startX: number;
  startY: number;
  initialLeft: number;
  initialTop: number;
  currentLeft: number;
  currentTop: number;
  nodeId: string | null;
  elementClone: { html: string; width: number; height: number; offsetX: number; offsetY: number } | null;
}

export const PageContainer = ({ children, useFixedWidth = false }: { children: any; useFixedWidth?: boolean }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [highlightRect, setHighlightRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isDraggable, setIsDraggable] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    startX: 0,
    startY: 0,
    initialLeft: 0,
    initialTop: 0,
    currentLeft: 0,
    currentTop: 0,
    nodeId: null,
    elementClone: null,
  });

  // 发送选择变化到父窗口
  const notifySelection = (nodeId: string | null) => {
    if (window.parent !== window) {
      window.parent.postMessage({
        type: 'NODE_SELECTED',
        payload: { nodeId }
      }, '*');
    }
  };

  // 发送拖动结束消息到父窗口
  const notifyDragEnd = (nodeId: string, deltaX: number, deltaY: number) => {
    if (window.parent !== window) {
      window.parent.postMessage({
        type: 'NODE_DRAG_END',
        payload: { nodeId, deltaX, deltaY }
      }, '*');
    }
  };

  // 检查元素是否可以拖拽
  const checkIsDraggable = (nodeId: string): boolean => {
    if (!containerRef.current) return false;

    const selectedElement = containerRef.current.querySelector(`[data-node-id="${nodeId}"]`) as HTMLElement;
    if (!selectedElement) return false;

    const parentElement = selectedElement.parentElement;
    if (!parentElement || parentElement.tagName.toLowerCase() !== 'div') return false;

    // 检查父元素的 position 是否为 relative（相对定位容器）
    const parentStyle = window.getComputedStyle(parentElement);
    if (parentStyle.position === 'relative') return true;

    // 检查父元素的 className 是否包含 'relative'
    if (parentElement.className && typeof parentElement.className === 'string' && parentElement.className.includes('relative')) {
      return true;
    }

    return false;
  };

  // 处理选择变化
  const handleSelectNode = (nodeId: string | null) => {
    setSelectedId(nodeId);
    if (nodeId) {
      const draggable = checkIsDraggable(nodeId);
      setIsDraggable(draggable);
    } else {
      setIsDraggable(false);
    }
    notifySelection(nodeId);
  };

  // 监听来自父窗口的消息
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'SELECT_NODE') {
        const { nodeId } = event.data.payload;
        setSelectedId(nodeId);
        notifySelection(nodeId);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  // Handle selection by clicking on the preview
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dragState.isDragging) return;

      let target = e.target as HTMLElement;
      while (target && target !== containerRef.current) {
        const nodeId = target.getAttribute('data-node-id');
        if (nodeId) {
          handleSelectNode(nodeId);
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        target = target.parentElement as HTMLElement;
      }
    };

    containerRef.current?.addEventListener('click', handleClick, true);
    return () => {
      containerRef.current?.removeEventListener('click', handleClick, true);
    };
  }, [dragState.isDragging]);

  // 处理拖动开始
  const handleDragStart = (e: React.MouseEvent, nodeId: string) => {
    if (!containerRef.current) return;

    const selectedElement = containerRef.current.querySelector(`[data-node-id="${nodeId}"]`) as HTMLElement;
    if (!selectedElement) return;

    const elementRect = selectedElement.getBoundingClientRect();

    const clone = selectedElement.cloneNode(true) as HTMLElement;
    clone.removeAttribute('data-node-id');

    const computedStyle = window.getComputedStyle(selectedElement);

    const styles = `
      width: ${elementRect.width}px !important;
      height: ${elementRect.height}px !important;
      margin: 0 !important;
      padding: ${computedStyle.paddingTop} ${computedStyle.paddingRight} ${computedStyle.paddingBottom} ${computedStyle.paddingLeft} !important;
      box-sizing: ${computedStyle.boxSizing} !important;
      display: ${computedStyle.display} !important;
      opacity: 0.6;
      pointer-events: none;
      z-index: 10000;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
      transform: scale(1.02);
      background-color: ${computedStyle.backgroundColor};
      color: ${computedStyle.color};
      font-size: ${computedStyle.fontSize};
      font-family: ${computedStyle.fontFamily};
    `;

    clone.setAttribute('style', styles);

    setDragState({
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      initialLeft: elementRect.left,
      initialTop: elementRect.top,
      currentLeft: elementRect.left,
      currentTop: elementRect.top,
      nodeId,
      elementClone: {
        html: clone.outerHTML,
        width: elementRect.width,
        height: elementRect.height,
        offsetX: e.clientX - elementRect.left,
        offsetY: e.clientY - elementRect.top,
      },
    });

    e.stopPropagation();
    e.preventDefault();
  };

  // 处理拖动
  useEffect(() => {
    if (!dragState.isDragging || !dragState.nodeId) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newLeft = e.clientX - dragState.elementClone!.offsetX;
      const newTop = e.clientY - dragState.elementClone!.offsetY;

      setDragState(prev => ({
        ...prev,
        currentLeft: newLeft,
        currentTop: newTop,
      }));
    };

    const handleMouseUp = (e: MouseEvent) => {
      const deltaX = e.clientX - dragState.startX;
      const deltaY = e.clientY - dragState.startY;

      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        notifyDragEnd(dragState.nodeId!, deltaX, deltaY);
      }

      setDragState({
        isDragging: false,
        startX: 0,
        startY: 0,
        initialLeft: 0,
        initialTop: 0,
        currentLeft: 0,
        currentTop: 0,
        nodeId: null,
        elementClone: null,
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState]);

  // Sync highlight overlay position
  useEffect(() => {
    if (!selectedId || !containerRef.current) {
      setHighlightRect(null);
      return;
    }
    const selectedElement = containerRef.current.querySelector(`[data-node-id="${selectedId}"]`) as HTMLElement;
    if (selectedElement) {
      const containerRect = containerRef.current.getBoundingClientRect();
      const rect = selectedElement.getBoundingClientRect();

      const top = rect.top - containerRect.top;
      const left = rect.left - containerRect.left;

      setHighlightRect({
        top,
        left,
        width: rect.width,
        height: rect.height
      });

      selectedElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      setHighlightRect(null);
    }
  }, [selectedId, children]);

  // 处理滚动事件，滚动时隐藏highlightRect，停止滚动后显示并更新
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      // 滚动开始，隐藏highlightRect
      setIsScrolling(true);

      // 清除之前的定时器
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }

      // 设置新的定时器，100ms后认为滚动停止
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);

        // 滚动停止后，更新highlightRect位置
        if (selectedId && containerRef.current) {
          const selectedElement = containerRef.current.querySelector(`[data-node-id="${selectedId}"]`) as HTMLElement;
          if (selectedElement) {
            const containerRect = containerRef.current.getBoundingClientRect();
            const rect = selectedElement.getBoundingClientRect();

            const top = rect.top - containerRect.top;
            const left = rect.left - containerRect.left;

            setHighlightRect({
              top,
              left,
              width: rect.width,
              height: rect.height
            });
          }
        }
      }, 100);
    };

    container.addEventListener('scroll', handleScroll, true);

    return () => {
      container.removeEventListener('scroll', handleScroll, true);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [selectedId]);

  return (
    <>
      <div
        ref={containerRef}
        style={{
          position: 'relative',
          width: useFixedWidth ? '1920px' : '100%',
          height: useFixedWidth ? '1080px' : '100%',
          overflow: 'auto',
          padding: '20px',
        }}
      >
        {children}
      </div>

      {dragState.isDragging && dragState.elementClone && (
        <div
          style={{
            position: 'fixed',
            left: 0,
            top: 0,
            transform: `translate(${dragState.currentLeft}px, ${dragState.currentTop}px)`,
            width: dragState.elementClone.width,
            height: dragState.elementClone.height,
            zIndex: 50,
            pointerEvents: 'none',
          }}
          dangerouslySetInnerHTML={{ __html: dragState.elementClone.html }}
        />
      )}

      {highlightRect && !dragState.isDragging && !isScrolling && (
        <div
          style={{
            position: 'absolute',
            top: highlightRect.top,
            left: highlightRect.left,
            width: highlightRect.width,
            height: highlightRect.height,
            zIndex: 10,
            pointerEvents: 'none',
          }}
        >
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            border: '2px solid #3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)'
          }} />

          {isDraggable && (
            <div
              style={{
                position: 'absolute',
                top: -8,
                left: 0,
                right: 0,
                height: '8px',
                backgroundColor: '#3b82f6',
                cursor: 'move',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'auto',
                borderTopLeftRadius: '4px',
                borderTopRightRadius: '4px',
              }}
              onMouseDown={(e) => handleDragStart(e, selectedId!)}
              title="拖动组件"
            >
              <div style={{ display: 'flex', gap: '2px' }}>
                <div style={{ width: '4px', height: '4px', backgroundColor: 'white', borderRadius: '50%' }}></div>
                <div style={{ width: '4px', height: '4px', backgroundColor: 'white', borderRadius: '50%' }}></div>
                <div style={{ width: '4px', height: '4px', backgroundColor: 'white', borderRadius: '50%' }}></div>
              </div>
            </div>
          )}

          <div style={{
            position: 'absolute',
            top: -32,
            left: 0,
            backgroundColor: '#2563eb',
            color: 'white',
            fontSize: '10px',
            paddingLeft: '8px',
            paddingRight: '8px',
            paddingTop: '2px',
            paddingBottom: '2px',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
            whiteSpace: 'nowrap'
          }}>
            <div style={{ width: '6px', height: '6px', backgroundColor: 'white', borderRadius: '50%' }}></div>
            {selectedId}
          </div>

          <div style={{
            position: 'absolute',
            bottom: -24,
            left: 0,
            backgroundColor: '#1e293b',
            color: 'white',
            fontSize: '9px',
            paddingLeft: '8px',
            paddingRight: '8px',
            paddingTop: '2px',
            paddingBottom: '2px',
            borderRadius: '4px',
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
            whiteSpace: 'nowrap',
            fontFamily: 'monospace'
          }}>
            x: {Math.round(highlightRect.left)} y: {Math.round(highlightRect.top)}
          </div>
        </div>
      )}

      {dragState.isDragging && (
        <div
          style={{
            position: 'fixed',
            zIndex: 50,
            pointerEvents: 'none',
            backgroundColor: '#2563eb',
            color: 'white',
            fontSize: '12px',
            paddingLeft: '12px',
            paddingRight: '12px',
            paddingTop: '6px',
            paddingBottom: '6px',
            borderRadius: '8px',
            boxShadow: '0 10px 15px rgba(0, 0, 0, 0.1)',
            whiteSpace: 'nowrap',
            left: dragState.currentLeft + dragState.elementClone!.width / 2,
            top: dragState.currentTop - 35,
            transform: 'translateX(-50%)',
          }}
        >
          移动: {Math.round(dragState.currentLeft - dragState.initialLeft)}, {Math.round(dragState.currentTop - dragState.initialTop)}
        </div>
      )}
    </>
  );
};

export function Canvas() {
  const [activePage] = useState(() => {
    const defaultPath = '@/pages/dashboard/Dashboard.tsx';
    try {
      const loc = typeof window !== 'undefined' ? window.location : undefined;
      if (!loc) return defaultPath;
      const search = loc.search || (loc.hash && loc.hash.includes('?') ? loc.hash.split('?')[1] : '');
      const params = new URLSearchParams(search);
      const param = params.get('page') || params.get('path');
      if (!param) return defaultPath;
      // if (param.startsWith('./') || param.startsWith('../')) return param;
      // if (param.startsWith('/')) return `.${param}`;
      return `/${param}`;
    } catch {
      return defaultPath;
    }
  })

  // 检查是否使用固定宽度（用于 desktop 等大屏预览）
  const [useFixedWidth] = useState(() => {
    try {
      const loc = typeof window !== 'undefined' ? window.location : undefined;
      if (!loc) return false;
      const search = loc.search || (loc.hash && loc.hash.includes('?') ? loc.hash.split('?')[1] : '');
      const params = new URLSearchParams(search);
      return params.get('fixedWidth') === 'true';
    } catch {
      return false;
    }
  })

  const loc = typeof window !== 'undefined' ? window.location : undefined;
  const path = loc?.pathname || '';
  const isCanvas = path.endsWith('/__editor_canvas');

  const renderPage = useMemo(() => {
    const PageComponent = lazy(() => import(/* @vite-ignore */ activePage));

    if (isCanvas) {
      return (
        <Suspense fallback={<div style={{ color: '#6b7280', padding: '40px', textAlign: 'center' }}>页面加载中...</div>}>
          <PageContainer useFixedWidth={useFixedWidth}>
            <PageComponent />
          </PageContainer>
        </Suspense>
      );
    }

    return (
      <Suspense fallback={<div style={{ color: '#6b7280', padding: '40px', textAlign: 'center' }}>页面加载中...</div>}>
        <div style={{ padding: 20 }}>
          <PageComponent />
        </div>
      </Suspense>
    );
  }, [activePage, useFixedWidth]);

  return renderPage
}

export default Canvas;