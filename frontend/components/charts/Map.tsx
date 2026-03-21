// Force refresh v3 - CACHE BUST
import MapContainer from './map/MapContainer';

interface MapProps {
  sourceMode?: string;
  mapFilterScope?: 'full' | 'raceLegOnly';
  [key: string]: any;
}

export default function Map(props: MapProps) {
  const sourceMode = props?.sourceMode || 'single';
  return <MapContainer {...props} sourceMode={sourceMode} enableTimeWindow={true} />;
}
