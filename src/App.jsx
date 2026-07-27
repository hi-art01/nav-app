import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import './App.css'
import './layer-fix.css'
import './heading.css'

const DEMO_POSITION = [27.6448, -82.5691]
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(`helm:${key}`)) ?? fallback } catch { return fallback } }
const store = (key, value) => localStorage.setItem(`helm:${key}`, JSON.stringify(value))

const createBoatIcon = (headingDeg) => {
  if (!window.L) return null
  return window.L.divIcon({
    className: 'boat-pin',
    html: `<svg class="boat-arrow-svg" width="24" height="24" viewBox="0 0 24 24" style="transform: rotate(${headingDeg}deg); transform-origin: 12px 12px;">
      <path d="M12,2 L21,21 L12,16.5 L3,21 Z" fill="#40d8b5" stroke="#05201e" stroke-width="1.8" stroke-linejoin="round" />
    </svg>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  })
}

const getMarkerIcon = (type) => {
  if (!window.L) return null
  let symbol = '🐟'
  if (type === 'Lobster pot') symbol = '⚓'
  else if (type === 'Hazard') symbol = '⚠️'
  else if (type === 'Anchor point') symbol = '⚓'
  else if (type === 'Buoy / Navigation mark') symbol = '🔔'
  return window.L.divIcon({ className: 'map-pin', html: `<span>${symbol}</span>` })
}

function Navigator() {
  const mapNode = useRef(null)
  const map = useRef(null)
  const tileLayers = useRef([])
  const modeRef = useRef(null)
  const adjustingPositionRef = useRef(false)
  const userMarker = useRef(null)
  const accuracyCircle = useRef(null)
  const layers = useRef([])
  const watch = useRef(null)
  const wakeLock = useRef(null)
  const trackingRef = useRef(false)
  const activeDestinationRef = useRef(null)
  const headingRef = useRef(0)
  const hasHeadingRef = useRef(false)
  const followHeadingRef = useRef(false)
  const gpsHeadingRef = useRef(false)
  const lastTravelPointRef = useRef(null)
  const fileInputRef = useRef(null)

  const [markers, setMarkers] = useState(() => read('markers', []))
  const [destinations, setDestinations] = useState(() => read('destinations', []))
  const [trips, setTrips] = useState(() => read('trips', []))
  const [position, setPosition] = useState(DEMO_POSITION)
  const [accuracy, setAccuracy] = useState(null)
  const [tracking, setTracking] = useState(false)
  const [depth, setDepth] = useState('')
  const [mode, setMode] = useState(null)
  const [editingMarker, setEditingMarker] = useState(null)
  const [relocatingMarkerId, setRelocatingMarkerId] = useState(null)
  const relocatingMarkerRef = useRef(null)
  const [adjustingPosition, setAdjustingPosition] = useState(false)
  const [activeDestination, setActiveDestination] = useState(null)
  const [notice, setNotice] = useState('Ready to navigate')
  const [heading, setHeading] = useState(0)
  const [followHeading, setFollowHeading] = useState(false)
  const [showDepthChart, setShowDepthChart] = useState(false)
  const [mapStyle, setMapStyle] = useState('satellite')
  const [mapReady, setMapReady] = useState(false)
  const [draft, setDraft] = useState({ name: '', type: 'Fish spot', coords: null })

  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { adjustingPositionRef.current = adjustingPosition }, [adjustingPosition])
  useEffect(() => { trackingRef.current = tracking }, [tracking])
  useEffect(() => { activeDestinationRef.current = activeDestination }, [activeDestination])
  useEffect(() => { followHeadingRef.current = followHeading; if (!followHeading) gpsHeadingRef.current = false }, [followHeading])
  useEffect(() => { relocatingMarkerRef.current = relocatingMarkerId }, [relocatingMarkerId])

  useEffect(() => {
    if (!tracking) return undefined
    const keepScreenAwake = async () => {
      if (!('wakeLock' in navigator)) return
      try { wakeLock.current = await navigator.wakeLock.request('screen') } catch { /* device/browser may deny wake lock */ }
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') keepScreenAwake() }
    keepScreenAwake()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility); wakeLock.current?.release(); wakeLock.current = null }
  }, [tracking])

  useEffect(() => { store('markers', markers) }, [markers])
  useEffect(() => { store('destinations', destinations) }, [destinations])
  useEffect(() => { store('trips', trips) }, [trips])

  useEffect(() => {
    const setup = () => {
      const L = window.L
      map.current = L.map(mapNode.current, { zoomControl: false }).setView(DEMO_POSITION, 13)
      const routesPane = map.current.createPane('routesPane')
      routesPane.style.zIndex = 650
      const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' }).addTo(map.current)
      tileLayers.current = [satelliteLayer]
      map.current.on('click', (event) => {
        if (relocatingMarkerRef.current) {
          const newCoords = [event.latlng.lat, event.latlng.lng]
          const targetId = relocatingMarkerRef.current
          setMarkers((list) => list.map((m) => (m.id === targetId ? { ...m, coords: newCoords } : m)))
          setEditingMarker((prev) => (prev && prev.id === targetId ? { ...prev, coords: newCoords } : prev))
          setRelocatingMarkerId(null)
          setNotice('Marker location updated on chart')
          return
        }
        if (adjustingPositionRef.current) {
          const coords = { latitude: event.latlng.lat, longitude: event.latlng.lng, accuracy: 0 }
          updatePosition(coords)
          setAdjustingPosition(false)
          setNotice('Position adjusted manually')
          return
        }
        if (!modeRef.current) return
        setDraft((current) => ({ ...current, coords: [event.latlng.lat, event.latlng.lng] }))
      })
      setMapReady(true)
    }
    if (window.L) setup()
    else document.getElementById('leaflet-js').addEventListener('load', setup, { once: true })
    return () => { if (map.current) map.current.remove() }
  }, [])

  useEffect(() => {
    if (!map.current || !window.L) return
    const L = window.L
    tileLayers.current.forEach((layer) => layer.remove())
    const satellite = mapStyle === 'satellite'
    if (satellite) {
      tileLayers.current = [L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' }).addTo(map.current)]
    } else {
      const oceanBase = L.tileLayer('https://services.arcgisonline.com/arcgis/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri, GEBCO, NOAA' }).addTo(map.current)
      const bathymetryLayer = L.tileLayer.wms('https://ows.emodnet-bathymetry.eu/wms', { layers: 'mean_rainbowcolour', format: 'image/png', transparent: true, version: '1.3.0', opacity: 0.65, attribution: 'EMODnet Bathymetry' }).addTo(map.current)
      const chartLayer = L.tileLayer.wms('https://encdirect.noaa.gov/arcgis/services/encdirect/enc_approach/MapServer/WMSServer', { layers: 'show:79,80,108,232', format: 'image/png', transparent: true, version: '1.3.0', opacity: 0.95, attribution: 'NOAA ENC depth soundings' }).addTo(map.current)
      const oceanRef = L.tileLayer('https://services.arcgisonline.com/arcgis/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, opacity: 0.85, attribution: 'Esri Ocean Reference' }).addTo(map.current)
      const seamarkLayer = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { maxZoom: 19, opacity: 0.9, attribution: 'OpenSeaMap' }).addTo(map.current)
      tileLayers.current = [oceanBase, bathymetryLayer, chartLayer, oceanRef, seamarkLayer]
    }
    setNotice(satellite ? 'Satellite imagery enabled' : 'C-MAP Bathymetric Depth Chart enabled')
  }, [mapStyle])

  const selectedTrip = useMemo(() => activeDestination ? trips.find((trip) => trip.destinationId === activeDestination) : null, [trips, activeDestination])

  useEffect(() => {
    if (!map.current || !window.L) return
    const L = window.L
    layers.current.forEach((layer) => layer.remove())
    layers.current = []
    markers.forEach((marker) => {
      const icon = getMarkerIcon(marker.type)
      layers.current.push(L.marker(marker.coords, { icon }).bindPopup(`<b>${marker.name}</b><br>${marker.type}${marker.depth ? `<br>${marker.depth} ft` : ''}`).addTo(map.current))
    })
    destinations.forEach((destination) => {
      const icon = L.divIcon({ className: 'destination-pin', html: '◆' })
      layers.current.push(L.marker(destination.coords, { icon }).bindTooltip(destination.name).addTo(map.current))
    })
    const visibleTrips = activeDestination ? trips.filter((trip) => trip.destinationId === activeDestination) : trips
    visibleTrips.forEach((trip) => {
      if (trip.points.length) {
        const points = trip.points.length > 1 ? trip.points : [trip.points[0], trip.points[0]]
        layers.current.push(L.polyline(points, { pane: 'routesPane', color: activeDestination ? '#37d4b4' : '#79a8ff', weight: activeDestination ? 6 : 4, opacity: activeDestination ? .95 : .85, lineCap: 'round', lineJoin: 'round' }).addTo(map.current))
      }
    })
  }, [markers, destinations, trips, activeDestination, mapReady])

  useEffect(() => {
    if (!userMarker.current || !window.L) return
    userMarker.current.setIcon(createBoatIcon(heading))
  }, [heading])

  function updatePosition(coords) {
    const next = [coords.latitude, coords.longitude]
    setPosition(next)
    if (Number.isFinite(coords.accuracy)) setAccuracy(coords.accuracy)
    
    const previous = lastTravelPointRef.current
    let course = Number.isFinite(coords.heading) && coords.heading >= 0 && (coords.speed == null || coords.speed > 0.3) ? coords.heading : null
    if (course == null && previous) {
      const lat1 = previous.latitude * Math.PI / 180; const lat2 = coords.latitude * Math.PI / 180
      const dLon = (coords.longitude - previous.longitude) * Math.PI / 180
      const y = Math.sin(dLon) * Math.cos(lat2); const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
      const moved = Math.hypot(coords.latitude - previous.latitude, (coords.longitude - previous.longitude) * Math.cos(lat2)) * 111320
      if (moved >= 1.5) course = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
    }
    if (course != null) {
      const delta = ((course - headingRef.current + 540) % 360) - 180
      if (!hasHeadingRef.current) { headingRef.current = course; hasHeadingRef.current = true }
      else if (Math.abs(delta) > 0.5) headingRef.current = (headingRef.current + delta * 0.2 + 360) % 360
      setHeading(headingRef.current)
    }
    lastTravelPointRef.current = { latitude: coords.latitude, longitude: coords.longitude }

    if (map.current && window.L) {
      if (!userMarker.current) userMarker.current = window.L.marker(next, { icon: createBoatIcon(headingRef.current) }).addTo(map.current)
      else userMarker.current.setLatLng(next)
      if (!accuracyCircle.current) accuracyCircle.current = window.L.circle(next, { radius: coords.accuracy || 10, color: '#58e1c4', weight: 1, fillColor: '#58e1c4', fillOpacity: 0.12 }).addTo(map.current)
      else accuracyCircle.current.setLatLng(next).setRadius(coords.accuracy || 10)
      map.current.panTo(next)
    }
    if (trackingRef.current && activeDestinationRef.current) {
      setTrips((previous) => previous.map((trip) => trip.destinationId === activeDestinationRef.current ? { ...trip, points: [...trip.points, next] } : trip))
    }
  }

  function toggleTracking() {
    if (tracking) {
      navigator.geolocation?.clearWatch(watch.current)
      watch.current = null
      trackingRef.current = false
      lastTravelPointRef.current = null
      setTracking(false); setNotice('Track saved on this device')
      return
    }
    if (!activeDestination) { setNotice('Choose a destination before starting a trip'); return }
    lastTravelPointRef.current = { latitude: position[0], longitude: position[1] }
    setTrips((old) => old.some((trip) => trip.destinationId === activeDestination) ? old : [...old, { id: uid(), destinationId: activeDestination, points: [position, position], createdAt: Date.now() }])
    trackingRef.current = true
    setTracking(true); setNotice('Recording your route — screen will stay awake')
    if (navigator.geolocation) watch.current = navigator.geolocation.watchPosition((p) => updatePosition(p.coords), () => setNotice('GPS unavailable — demo position is active'), { enableHighAccuracy: true, maximumAge: 0, timeout: 3000 })
    else setNotice('GPS is not supported by this browser')
  }

  function locate() {
    if (!navigator.geolocation) { setNotice('GPS is not supported by this browser'); return }
    setNotice('Improving GPS fix… hold still for a few seconds')
    let best = null
    const finish = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId)
      if (best) setNotice(`GPS fix ±${Math.round(best.accuracy || 0)} m`)
      else setNotice('Location unavailable — showing demo waters')
    }
    const watchId = navigator.geolocation.watchPosition((p) => {
      if (!best || (p.coords.accuracy || Infinity) < (best.coords.accuracy || Infinity)) {
        best = p
        updatePosition(p.coords)
        if (p.coords.accuracy && p.coords.accuracy <= 5) finish()
      }
    }, () => setNotice('Location permission denied — showing demo waters'), { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 })
    setTimeout(finish, 8000)
  }

  function togglePositionAdjustment() {
    setAdjustingPosition((current) => {
      const next = !current
      setNotice(next ? 'Tap the map to place your vessel precisely' : 'Position adjustment cancelled')
      return next
    })
  }

  function toggleMapStyle() { setMapStyle((style) => style === 'satellite' ? 'nautical' : 'satellite') }

  function selectDestination(id) {
    activeDestinationRef.current = id
    setActiveDestination(id)
    const destination = destinations.find((item) => item.id === id)
    if (destination) map.current?.flyTo(destination.coords, 15)
    setNotice(`Showing routes to ${destination?.name || 'destination'}`)
  }

  function openEditMarker(marker) {
    setEditingMarker({ ...marker })
  }

  function saveEditedMarker(e) {
    e.preventDefault()
    if (!editingMarker) return
    if (!editingMarker.name.trim()) { setNotice('Marker requires a name'); return }
    setMarkers((list) => list.map((item) => item.id === editingMarker.id ? editingMarker : item))
    setEditingMarker(null)
    setRelocatingMarkerId(null)
    setNotice(`Marker "${editingMarker.name}" updated`)
  }

  function deleteMarker(id) {
    const marker = markers.find((item) => item.id === id)
    if (!marker || !window.confirm(`Delete “${marker.name}”?`)) return
    setMarkers((list) => list.filter((item) => item.id !== id)); setNotice('Marker deleted')
  }

  async function exportZip() {
    const zip = new JSZip()
    zip.file('helm-navigation.json', JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), markers, destinations, trips }, null, 2))
    const blob = await zip.generateAsync({ type: 'blob' })
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `helm-navigation-${new Date().toISOString().slice(0, 10)}.zip`; link.click(); URL.revokeObjectURL(link.href)
    setNotice('Navigation backup exported')
  }

  async function importZip(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const zip = await JSZip.loadAsync(file)
      const jsonFile = zip.file('helm-navigation.json')
      if (!jsonFile) throw new Error('This ZIP does not contain Helm navigation data.')
      const data = JSON.parse(await jsonFile.async('string'))
      if (!Array.isArray(data.markers) || !Array.isArray(data.destinations) || !Array.isArray(data.trips)) throw new Error('Invalid Helm navigation backup.')
      setMarkers(data.markers); setDestinations(data.destinations); setTrips(data.trips); activeDestinationRef.current = null; setActiveDestination(null); setNotice('Navigation backup imported')
    } catch (error) { setNotice(error.message || 'Could not import that ZIP') }
  }

  async function toggleHeading() {
    if (followHeading) { setFollowHeading(false); setNotice('North-up map'); return }
    headingRef.current = 0; hasHeadingRef.current = false; lastTravelPointRef.current = { latitude: position[0], longitude: position[1] }
    setFollowHeading(true); setNotice(tracking ? 'Following your GPS course' : 'Start tracking to follow your boat course')
  }

  function savePoint() {
    if (!draft.name.trim()) { setNotice('Give this location a name'); return }
    const coords = draft.coords || position
    if (mode === 'destination') {
      const item = { id: uid(), name: draft.name.trim(), coords }
      setDestinations((list) => [...list, item]); activeDestinationRef.current = item.id; setActiveDestination(item.id); setNotice(`${item.name} is ready for a trip`)
    } else {
      setMarkers((list) => [...list, { id: uid(), name: draft.name.trim(), type: draft.type, coords, depth: depth || null }]); setNotice('Marker dropped')
    }
    setMode(null); setDraft({ name: '', type: 'Fish spot', coords: null }); setDepth('')
  }

  const active = destinations.find((destination) => destination.id === activeDestination)
  const depthPoints = markers.filter((marker) => Number.isFinite(Number(marker.depth)) && Number(marker.depth) > 0).sort((a, b) => Number(a.depth) - Number(b.depth))
  const maxDepth = Math.max(...depthPoints.map((marker) => Number(marker.depth)), 1)

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">⌁</div><div><b>HELM</b><small>MARINE NAVIGATION</small></div></div>
      <div className="status"><span className={tracking ? 'live-dot' : ''}></span>{notice}</div>
      <section><p className="eyebrow">YOUR VOYAGE</p><h1>{active ? active.name : 'No destination set'}</h1><p className="subtle">{active ? `${selectedTrip?.points.length || 0} recorded waypoints` : 'Select a saved location to begin'}</p>
        <button className={tracking ? 'primary recording' : 'primary'} onClick={toggleTracking}>{tracking ? '■  End & save track' : '▶  Start trip tracking'}</button>
      </section>
      <section className="section"><div className="section-title"><p className="eyebrow">DESTINATIONS</p><button className="icon-button" onClick={() => setMode('destination')}>＋</button></div>
        <div className="destination-list">{destinations.length ? destinations.map((d) => <button key={d.id} className={activeDestination === d.id ? 'destination active' : 'destination'} onClick={() => selectDestination(d.id)}><span>◆</span><div>{d.name}<small>{trips.filter((t) => t.destinationId === d.id).length} {trips.filter((t) => t.destinationId === d.id).length === 1 ? 'trip' : 'trips'}</small></div></button>) : <p className="empty">Add a destination, then tap it to see its saved routes.</p>}</div>
      </section>
      <section className="section marker-section"><p className="eyebrow">SAVED MARKERS</p>{markers.length ? <div className="marker-list">{markers.map((marker) => <div className="marker-row" key={marker.id}><button className="marker-jump" onClick={() => map.current?.flyTo(marker.coords, 16)}><span>{marker.type === 'Lobster pot' ? '⚓' : marker.type === 'Hazard' ? '⚠️' : marker.type === 'Anchor point' ? '⚓' : marker.type === 'Buoy / Navigation mark' ? '🔔' : '🐟'}</span><div>{marker.name}<small>{marker.depth ? `${marker.depth} ft · ` : ''}{marker.type}</small></div></button><button className="marker-action" onClick={() => openEditMarker(marker)} title="Edit marker">✎</button><button className="marker-action delete" onClick={() => deleteMarker(marker.id)} title="Delete marker">×</button></div>)}</div> : <p className="empty">Your fish, hazard, and navigation markers will appear here.</p>}</section>
      <section className="section storage-section"><p className="eyebrow">ROUTE STORAGE</p><div className="storage-actions"><button onClick={exportZip}>⇩ Export ZIP</button><button onClick={() => fileInputRef.current?.click()}>⇧ Import ZIP</button><input ref={fileInputRef} type="file" accept=".zip,application/zip" onChange={importZip} hidden /></div></section>
      <section className="section"><p className="eyebrow">QUICK ACTIONS</p><div className="quick-actions"><button onClick={() => setMode('marker')}>🐟<span>Drop marker</span></button><button onClick={locate}>◎<span>My location</span></button><button className={adjustingPosition ? 'adjusting' : ''} onClick={togglePositionAdjustment}>⌖<span>Adjust position</span></button></div><button className={showDepthChart ? 'depth-toggle active' : 'depth-toggle'} onClick={() => setShowDepthChart((visible) => !visible)}>▥ <span>{showDepthChart ? 'Hide depth chart' : 'Show depth chart'}</span></button></section>
      <footer><span>GPS {navigator.geolocation ? 'READY' : 'UNAVAILABLE'}{accuracy ? ` · ±${Math.round(accuracy)}m` : ''}</span><span>{position[0].toFixed(4)}, {Math.abs(position[1]).toFixed(4)}°W</span></footer>
    </aside>
    <section className="map-area">
      <div ref={mapNode} style={{ '--map-rotation': followHeading ? `${-heading}deg` : '0deg' }} className={`${mode || relocatingMarkerId ? 'map picking' : 'map'}${followHeading ? ' heading-active' : ''}`}></div>
      <div className="map-top">
        <div><span className="map-label">{mapStyle === 'satellite' ? 'SATELLITE' : 'C-MAP NA-Y200 DEPTH CHART'}</span><p>{followHeading ? `HEADING ${Math.round(heading)}° · COMPASS FOLLOWING` : mapStyle === 'satellite' ? 'Live marine overview' : 'Charted depths and navigation marks'}</p></div>
        <button className="map-style-button" onClick={toggleMapStyle}>{mapStyle === 'satellite' ? '◈ Nautical depth chart' : '▣ Satellite view'}</button>
        <button onClick={() => setMode('marker')}>＋ Add spot</button>
        <button className={followHeading ? 'heading-button active' : 'heading-button'} onClick={toggleHeading}>{followHeading ? '✦ North-up' : '✧ Follow heading'}</button>
      </div>
      <div className="zoom-controls">
        <button title="Zoom in" onClick={() => map.current?.zoomIn()}>＋</button>
        <button title="Zoom out" onClick={() => map.current?.zoomOut()}>－</button>
      </div>
      {relocatingMarkerId && (
        <div className="relocate-banner">
          <span>Tap the chart to set new location for "{markers.find((m) => m.id === relocatingMarkerId)?.name || 'marker'}"</span>
          <button onClick={() => setRelocatingMarkerId(null)}>Cancel</button>
        </div>
      )}
      {mapStyle === 'nautical' && (
        <div className="cmap-depth-legend">
          <span><b>C-MAP NA-Y200 DEPTH CHART</b></span>
          <span style={{ color: '#82f0ec' }}>Shallow (0 ft)</span>
          <div className="depth-bar-gradient"></div>
          <span style={{ color: '#6366f1' }}>Deep (300+ ft)</span>
        </div>
      )}
      <div className="map-legend">
        <span><i className="route-key"></i>Saved route{active ? ` to ${active.name}` : 's'}</span>
        <span><i className="boat-key"><svg width="12" height="12" viewBox="0 0 24 24" style={{ display: 'inline-block', verticalAlign: 'middle' }}><path d="M12,2 L21,21 L12,16.5 L3,21 Z" fill="#40d8b5" stroke="#05201e" strokeWidth="2" /></svg></i> Your vessel</span>
      </div>
      {showDepthChart && <aside className="depth-panel"><div className="depth-header"><div><p className="eyebrow">REPORTED DEPTHS</p><strong>{depthPoints.length ? `${depthPoints.length} marked locations` : 'No depth reports yet'}</strong></div><button onClick={() => setShowDepthChart(false)}>×</button></div>{depthPoints.length ? <div className="depth-bars">{depthPoints.map((point) => <div className="depth-row" key={point.id}><span className="depth-name">{point.name}</span><div className="depth-track"><i style={{ width: `${Math.max(8, Number(point.depth) / maxDepth * 100)}%` }}></i></div><b>{point.depth} ft</b></div>)}</div> : <p className="depth-empty">Add a marker and enter its depth to build your chart.</p>}<small>Depths are user-reported at each saved marker.</small></aside>}
    </section>

    {mode && <div className="modal-backdrop"><form className="modal" onSubmit={(e) => { e.preventDefault(); savePoint() }}><button type="button" className="close" onClick={() => setMode(null)}>×</button><p className="eyebrow">{mode === 'destination' ? 'NEW DESTINATION' : 'NEW MARKER'}</p><h2>{mode === 'destination' ? 'Where are you going?' : 'Mark this water'}</h2><p className="subtle">{draft.coords ? 'Location selected on the chart' : 'Uses your current location — or click the chart to choose one.'}</p><label>Name<input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={mode === 'destination' ? 'e.g. North Channel' : 'e.g. Productive reef'} /></label>{mode === 'marker' && <><label>Marker type<select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}><option>Fish spot</option><option>Lobster pot</option><option>Hazard</option><option>Anchor point</option><option>Buoy / Navigation mark</option></select></label><label>Depth (feet)<input type="number" min="0" value={depth} onChange={(e) => setDepth(e.target.value)} placeholder="Optional" /></label></>}<button className="primary" type="submit">Save {mode === 'destination' ? 'destination' : 'marker'}</button></form></div>}

    {editingMarker && !relocatingMarkerId && (
      <div className="modal-backdrop">
        <form className="modal" onSubmit={saveEditedMarker}>
          <button type="button" className="close" onClick={() => setEditingMarker(null)}>×</button>
          <p className="eyebrow">EDIT MARKER</p>
          <h2>Modify location details</h2>
          <label>Name
            <input autoFocus value={editingMarker.name} onChange={(e) => setEditingMarker({ ...editingMarker, name: e.target.value })} required />
          </label>
          <label>Marker type
            <select value={editingMarker.type} onChange={(e) => setEditingMarker({ ...editingMarker, type: e.target.value })}>
              <option>Fish spot</option>
              <option>Lobster pot</option>
              <option>Hazard</option>
              <option>Anchor point</option>
              <option>Buoy / Navigation mark</option>
            </select>
          </label>
          <label>Depth (feet)
            <input type="number" min="0" value={editingMarker.depth || ''} onChange={(e) => setEditingMarker({ ...editingMarker, depth: e.target.value })} placeholder="Optional" />
          </label>
          <button type="button" className="secondary-btn" onClick={() => {
            setRelocatingMarkerId(editingMarker.id)
            setNotice(`Tap the map to set new location for "${editingMarker.name}"`)
          }}>⌖ Click chart to change location</button>
          {editingMarker.coords && (
            <p className="subtle" style={{ marginTop: '12px', fontSize: '11px' }}>
              Coordinates: {editingMarker.coords[0].toFixed(4)}, {editingMarker.coords[1].toFixed(4)}
            </p>
          )}
          <div className="modal-actions">
            <button className="primary" type="submit">Save Changes</button>
          </div>
        </form>
      </div>
    )}
  </main>
}

function App() {
  return <Navigator />
}

export default App

