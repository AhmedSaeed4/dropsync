type LoadingIndicatorProps = {
  fullScreen?: boolean;
  label?: string;
};

// The same brand, breathing diamond and progress track as the parse-time boot loader.
export function LoadingIndicator({ fullScreen = false, label = 'Loading DropSync' }: LoadingIndicatorProps) {
  return (
    <div className={fullScreen ? 'dropsync-loading dropsync-loading-screen' : 'dropsync-loading'} role="status" aria-label={label}>
      <div className="boot-brand" aria-hidden="true"><span className="boot-diamond"></span>DropSync</div>
      <div className="boot-track" aria-hidden="true"></div>
    </div>
  );
}
