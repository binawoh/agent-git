import { File as FileIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { readImage, splitAttachments } from "../store";

const imageName = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** A user message; files attached through the composer show as images or file chips. */
export function UserMessage({ text, pending }: { text: string; pending?: boolean }) {
  const { text: body, paths } = splitAttachments(text);
  return (
    <div className={`user-message ${pending ? "pending" : ""}`}>
      {paths.length > 0 && (
        <div className="user-attachments">
          {paths.map((path) => (imageName.test(path) ? <AttachedImage key={path} path={path} /> : <AttachedFile key={path} path={path} />))}
        </div>
      )}
      {body.trim() && <div className="user-bubble">{body}</div>}
    </div>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function AttachedImage({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void readImage(path).then((result) => {
      if (!cancelled) setUrl(result);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (url === null) return <AttachedFile path={path} />;
  if (url === undefined) return <div className="attached-image loading" title={path} />;
  return (
    <>
      <button type="button" className="attached-image" title={path} onClick={() => setZoomed(true)}>
        <img src={url} alt={fileName(path)} />
      </button>
      {zoomed && (
        <div className="image-viewer" onClick={() => setZoomed(false)}>
          <img src={url} alt={fileName(path)} />
        </div>
      )}
    </>
  );
}

function AttachedFile({ path }: { path: string }) {
  return (
    <span className="attached-file" title={path}>
      <FileIcon size={13} />
      {fileName(path)}
    </span>
  );
}
