import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const DEMO_POSITION = [27.6448, -82.5691]
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(`helm:${key}`)) ?? fallback } catch { return fallback } }
const store = (key, value) => localStorage.setItem(`helm:${key}`, JSON.stringify(value))

function Navigator() {
  const mapNode = useRef(null)
  const map = useRef(null)
  const modeRef = useRef(null)
  const userMarker = useRef(null)
  const layers = useRef([])
  const watch = useRef(null)
  const [markers, setMarkers] = useState(() => read('markers', []))
  const [destinations, setDestinations] = useState(() => read('destinations', []))
  const [trips, setTrips] = useState(() => read('trips', []))
  const [position, setPosition] = useState(DEMO_POSITION)
  const [tracking, setTracking] = useState(false)
  const [depth, setDepth] = useState('')
  const [mode, setMode] = useState(null)
  const [activeDestination, setActiveDestination] = useState(null)
  const [notice, setNotice] = useState('Ready to navigate')
  const [draft, setDraft] = useState({ name: '', type: 'Fish spot', coords: null })

  useEffect(() => { modeRef.current = mode }, [mode])

  useEffect(() => { store('markers', markers) }, [markers])
  useEffect(() => { store('destinations', destinations) }, [destinations])
  useEffect(() => { store('trips', trips) }, [trips])

  useEffect(() => {
    const setup = () => {
      const L = window.L
      map.current = L.map(mapNode.current, { zoomControl: false }).setView(DEMO_POSITION, 13)
      L.control.zoom({ position: 'bottomright' }).addTo(map.current)
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' }).addTo(map.current)
      map.current.on('click', (event) => {
        if (!modeRef.current) return
        setDraft((current) => ({ ...current, coords: [event.latlng.lat, event.latlng.lng] }))
      })
    }
    if (window.L) setup()
    else document.getElementById('leaflet-js').addEventListener('load', setup, { once: true })
    return () => { if (map.current) map.current.remove() }
  }, [])

  const selectedTrip = useMemo(() => activeDestination ? trips.find((trip) => trip.destinationId === activeDestination) : null, [trips, activeDestination])

  useEffect(() => {
    if (!map.current || !window.L) return
    const L = window.L
    layers.current.forEach((layer) => layer.remove())
    layers.current = []
    markers.forEach((marker) => {
      const icon = L.divIcon({ className: 'map-pin', html: `<span>${marker.type === 'Lobster pot' ? '⚓' : '🐟'}</span>` })
      layers.current.push(L.marker(marker.coords, { icon }).bindPopup(`<b>${marker.name}</b><br>${marker.type}${marker.depth ? `<br>${marker.depth} ft` : ''}`).addTo(map.current))
    })
    destinations.forEach((destination) => {
      const icon = L.divIcon({ className: 'destination-pin', html: '◆' })
      layers.current.push(L.marker(destination.coords, { icon }).bindTooltip(destination.name).addTo(map.current))
    })
    const visibleTrips = activeDestination ? trips.filter((trip) => trip.destinationId === activeDestination) : trips
    visibleTrips.forEach((trip) => {
      if (trip.points.length > 1) layers.current.push(L.polyline(trip.points, { color: activeDestination ? '#37d4b4' : '#79a8ff', weight: activeDestination ? 5 : 3, opacity: activeDestination ? .9 : .45 }).addTo(map.current))
    })
  }, [markers, destinations, trips, activeDestination])

  function updatePosition(coords) {
    const next = [coords.latitude, coords.longitude]
    setPosition(next)
    if (map.current && window.L) {
      if (!userMarker.current) userMarker.current = window.L.marker(next, { icon: window.L.divIcon({ className: 'boat-pin', html: '▲' }) }).addTo(map.current)
      else userMarker.current.setLatLng(next)
      map.current.panTo(next)
    }
    if (tracking && activeDestination) {
      setTrips((previous) => previous.map((trip) => trip.destinationId === activeDestination ? { ...trip, points: [...trip.points, next] } : trip))
    }
  }

  function toggleTracking() {
    if (tracking) {
      navigator.geolocation?.clearWatch(watch.current)
      watch.current = null
      setTracking(false); setNotice('Track saved on this device')
      return
    }
    if (!activeDestination) { setNotice('Choose a destination before starting a trip'); return }
    setTrips((old) => old.some((trip) => trip.destinationId === activeDestination) ? old : [...old, { id: uid(), destinationId: activeDestination, points: [position], createdAt: Date.now() }])
    setTracking(true); setNotice('Recording your route')
    if (navigator.geolocation) watch.current = navigator.geolocation.watchPosition((p) => updatePosition(p.coords), () => setNotice('GPS unavailable — demo position is active'), { enableHighAccuracy: true, maximumAge: 5000 })
    else setNotice('GPS is not supported by this browser')
  }

  function locate() {
    navigator.geolocation?.getCurrentPosition((p) => updatePosition(p.coords), () => setNotice('Location permission denied — showing demo waters'), { enableHighAccuracy: true })
  }

  function savePoint() {
    if (!draft.name.trim()) { setNotice('Give this location a name'); return }
    const coords = draft.coords || position
    if (mode === 'destination') {
      const item = { id: uid(), name: draft.name.trim(), coords }
      setDestinations((list) => [...list, item]); setActiveDestination(item.id); setNotice(`${item.name} is ready for a trip`)
    } else {
      setMarkers((list) => [...list, { id: uid(), name: draft.name.trim(), type: draft.type, coords, depth: depth || null }]); setNotice('Marker dropped')
    }
    setMode(null); setDraft({ name: '', type: 'Fish spot', coords: null }); setDepth('')
  }

  const active = destinations.find((destination) => destination.id === activeDestination)
  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">⌁</div><div><b>HELM</b><small>MARINE NAVIGATION</small></div></div>
      <div className="status"><span className={tracking ? 'live-dot' : ''}></span>{notice}</div>
      <section><p className="eyebrow">YOUR VOYAGE</p><h1>{active ? active.name : 'No destination set'}</h1><p className="subtle">{active ? `${selectedTrip?.points.length || 0} recorded waypoints` : 'Select a saved location to begin'}</p>
        <button className={tracking ? 'primary recording' : 'primary'} onClick={toggleTracking}>{tracking ? '■  End & save track' : '▶  Start trip tracking'}</button>
      </section>
      <section className="section"><div className="section-title"><p className="eyebrow">DESTINATIONS</p><button className="icon-button" onClick={() => setMode('destination')}>＋</button></div>
        <div className="destination-list">{destinations.length ? destinations.map((d) => <button key={d.id} className={activeDestination === d.id ? 'destination active' : 'destination'} onClick={() => { setActiveDestination(d.id); map.current?.flyTo(d.coords, 15); setNotice(`Showing routes to ${d.name}`) }}><span>◆</span><div>{d.name}<small>{trips.find((t) => t.destinationId === d.id)?.points.length || 0} route points</small></div></button>) : <p className="empty">Add a destination, then tap it to see its saved routes.</p>}</div>
      </section>
      <section className="section"><p className="eyebrow">QUICK ACTIONS</p><div className="quick-actions"><button onClick={() => setMode('marker')}>🐟<span>Drop marker</span></button><button onClick={locate}>◎<span>My location</span></button></div></section>
      <footer><span>GPS {navigator.geolocation ? 'READY' : 'UNAVAILABLE'}</span><span>{position[0].toFixed(4)}, {Math.abs(position[1]).toFixed(4)}°W</span></footer>
    </aside>
    <section className="map-area"><div ref={mapNode} className={mode ? 'map picking' : 'map'}></div><div className="map-top"><div><span className="map-label">SATELLITE / CHART</span><p>Live marine overview</p></div><button onClick={() => setMode('marker')}>＋ Add spot</button></div><div className="map-legend"><span><i className="route-key"></i>Saved route{active ? ` to ${active.name}` : 's'}</span><span><i className="boat-key">▲</i>Your vessel</span></div></section>
    {mode && <div className="modal-backdrop"><form className="modal" onSubmit={(e) => { e.preventDefault(); savePoint() }}><button type="button" className="close" onClick={() => setMode(null)}>×</button><p className="eyebrow">{mode === 'destination' ? 'NEW DESTINATION' : 'NEW MARKER'}</p><h2>{mode === 'destination' ? 'Where are you going?' : 'Mark this water'}</h2><p className="subtle">{draft.coords ? 'Location selected on the chart' : 'Uses your current location — or click the chart to choose one.'}</p><label>Name<input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={mode === 'destination' ? 'e.g. North Channel' : 'e.g. Productive reef'} /></label>{mode === 'marker' && <><label>Marker type<select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}><option>Fish spot</option><option>Lobster pot</option><option>Hazard</option><option>Anchor point</option></select></label><label>Depth (feet)<input type="number" min="0" value={depth} onChange={(e) => setDepth(e.target.value)} placeholder="Optional" /></label></>}<button className="primary" type="submit">Save {mode === 'destination' ? 'destination' : 'marker'}</button></form></div>}
  </main>
}

function App() {
  return <Navigator />
}

export default App
