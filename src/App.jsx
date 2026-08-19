import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import './App.css'
import './layer-fix.css'
import './heading.css'

const DEMO_POSITION = [27.6448, -82.5691]
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(`helm:${key}`)) ?? fallback } catch { return fallback } }
const store = (key, value) => localStorage.setItem(`helm:${key}`, JSON.stringify(value))

/** ArcGIS Maritime Chart Service expects display_params query parameter. */
function noaaExportDisplayParams(units) {
  const displayDepthUnits = units === 'meters' ? 1 : 2
  return JSON.stringify({
    ECDISParameters: {
      DynamicParameters: {
        Parameter: [{ name: 'DisplayDepthUnits', value: displayDepthUnits }]
      }
    }
  })
}

function boatIcon(hdg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28" style="transform:rotate(${hdg}deg);transform-origin:14px 14px;display:block;overflow:visible"><polygon points="14,2 23,26 14,20 5,26" fill="#e7fffb" stroke="#001a17" stroke-width="1.5"/></svg>`
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
  const _lastHeadingEventRef = useRef(0)
  const followHeadingRef = useRef(false)
  const gpsHeadingRef = useRef(false)
  const lastTravelPointRef = useRef(null)
  const fileInputRef = useRef(null)
  const relocatingMarkerRef = useRef(false)

  const [markers, setMarkers] = useState(() => read('markers', []))
  const [destinations, setDestinations] = useState(() => read('destinations', []))
  const [trips, setTrips] = useState(() => read('trips', []))
  const [position, setPosition] = useState(DEMO_POSITION)
  const [accuracy, setAccuracy] = useState(null)
  const [tracking, setTracking] = useState(false)
  const [depth, setDepth] = useState('')
  const [mode, setMode] = useState(null)
  const [adjustingPosition, setAdjustingPosition] = useState(false)
  const [activeDestination, setActiveDestination] = useState(null)
  const [notice, setNotice] = useState('Ready to navigate')
  const [heading, setHeading] = useState(0)
  const [followHeading, setFollowHeading] = useState(false)
  const [showDepthChart, setShowDepthChart] = useState(false)
  const [mapStyle, setMapStyle] = useState('satellite')
  const [noaaDepthUnits, setNoaaDepthUnits] = useState(() => read('noaaDepthUnits', 'meters'))
  const [encRefresh, setEncRefresh] = useState(0)
  const [mapReady, setMapReady] = useState(false)
  const [draft, setDraft] = useState({ name: '', type: 'Fish spot', coords: null })
  const [editingMarker, setEditingMarker] = useState(null)
  const [relocatingMarker, setRelocatingMarker] = useState(false)
  const [acquiringGPS, setAcquiringGPS] = useState(false)
  const [destDropdownOpen, setDestDropdownOpen] = useState(false)
  const [markerDropdownOpen, setMarkerDropdownOpen] = useState(false)

  const destDropdownRef = useRef(null)
  const markerDropdownRef = useRef(null)

  useEffect(() => { modeRef.current = mode }, [mode])

  // Click outside listener for dropdowns
  useEffect(() => {
    function handleClickOutside(event) {
      if (destDropdownRef.current && !destDropdownRef.current.contains(event.target)) {
        setDestDropdownOpen(false)
      }
      if (markerDropdownRef.current && !markerDropdownRef.current.contains(event.target)) {
        setMarkerDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])
  useEffect(() => { adjustingPositionRef.current = adjustingPosition }, [adjustingPosition])
  useEffect(() => { trackingRef.current = tracking }, [tracking])
  useEffect(() => { activeDestinationRef.current = activeDestination }, [activeDestination])
  useEffect(() => { followHeadingRef.current = followHeading; if (!followHeading) gpsHeadingRef.current = false }, [followHeading])
  useEffect(() => { relocatingMarkerRef.current = relocatingMarker }, [relocatingMarker])

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
      // zoomControl:false — we render our own buttons outside the rotating map div
      map.current = L.map(mapNode.current, { zoomControl: false }).setView(DEMO_POSITION, 13)
      const routesPane = map.current.createPane('routesPane')
      routesPane.style.zIndex = 650
      const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' }).addTo(map.current)
      tileLayers.current = [satelliteLayer]
      map.current.on('click', (event) => {
        if (adjustingPositionRef.current) {
          const coords = { latitude: event.latlng.lat, longitude: event.latlng.lng, accuracy: 0 }
          updatePosition(coords)
          setAdjustingPosition(false)
          setNotice('Position adjusted manually')
          return
        }
        if (relocatingMarkerRef.current) {
          setEditingMarker((prev) => prev ? { ...prev, coords: [event.latlng.lat, event.latlng.lng] } : prev)
          relocatingMarkerRef.current = false
          setRelocatingMarker(false)
          setNotice('New location selected — save to confirm')
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
    console.log('Rebuilding map layers — mapStyle:', mapStyle, 'noaaDepthUnits:', noaaDepthUnits, 'encRefresh:', encRefresh)
    tileLayers.current.forEach((layer) => layer.remove())
    const satellite = mapStyle === 'satellite'
    const encChart = mapStyle === 'enc'
    if (satellite) {
      tileLayers.current = [L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri' }).addTo(map.current)]
    } else if (mapStyle === 'nautical') {
      // Use NOAA NOAAChartDisplay export for the nautical depth chart so unit switching works.
      const ChartLayer = L.GridLayer.extend({
        createTile: function (coords, done) {
          const tile = document.createElement('img')
          tile.alt = ''
          tile.setAttribute('role', 'presentation')
          const size = this.getTileSize()
          const mapRef = this._map
          const nw = mapRef.unproject(coords.scaleBy(size), coords.z)
          const se = mapRef.unproject(coords.add([1, 1]).scaleBy(size), coords.z)
          const nw3857 = mapRef.options.crs.project(nw)
          const se3857 = mapRef.options.crs.project(se)
          const params = new URLSearchParams({
            bbox: `${nw3857.x},${se3857.y},${se3857.x},${nw3857.y}`,
            bboxSR: '3857', imageSR: '3857', size: `${size.x},${size.y}`,
            format: 'png32', transparent: 'false', layers: 'show:2', f: 'image',
            display_params: noaaExportDisplayParams(noaaDepthUnits),
            cacheBust: Date.now()
          })
          tile.onload = () => done(null, tile)
          tile.onerror = () => done(new Error('NOAA sounding export failed'), tile)
          tile.src = `https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/MapServer/export?${params}`
          return tile
        }
      })
      const chartLayer = new ChartLayer({ tileSize: 256, maxZoom: 19, attribution: 'NOAA Office of Coast Survey' }).addTo(map.current)
      chartLayer.on('tileerror', () => setNotice('NOAA depth soundings are temporarily unavailable'))
      tileLayers.current = [chartLayer]
    } else if (encChart) {
      // NOAA ENC official chart symbology. Use dynamic NOAAChartDisplay export.
      const EncLayer = L.GridLayer.extend({
        createTile: function (coords, done) {
          const tile = document.createElement('img')
          tile.alt = ''
          tile.setAttribute('role', 'presentation')
          const size = this.getTileSize()
          const mapRef = this._map
          const nw = mapRef.unproject(coords.scaleBy(size), coords.z)
          const se = mapRef.unproject(coords.add([1, 1]).scaleBy(size), coords.z)
          const nw3857 = mapRef.options.crs.project(nw)
          const se3857 = mapRef.options.crs.project(se)
          const queryObj = {
            bbox: `${nw3857.x},${se3857.y},${se3857.x},${nw3857.y}`,
            bboxSR: '3857', imageSR: '3857', size: `${size.x},${size.y}`,
            format: 'png32', transparent: 'false', layers: 'show:0,1,2,3,4,5,6,7', f: 'image',
            display_params: noaaExportDisplayParams(noaaDepthUnits),
            cacheBust: Date.now()
          }
          const params = new URLSearchParams(queryObj)
          const fullUrl = `https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/MapServer/export?${params.toString()}`
          tile.onload = () => done(null, tile)
          tile.onerror = () => done(new Error('NOAA ENC export failed'), tile)
          console.log('NOAA ENC export URL', params.toString(), 'units', noaaDepthUnits)
          tile.src = fullUrl
          return tile
        }
      })
      const enc = new EncLayer({ tileSize: 256, maxZoom: 19, attribution: 'NOAA ENC Online · Office of Coast Survey' }).addTo(map.current)
      enc.on('tileerror', () => setNotice('NOAA ENC chart export is temporarily unavailable'))
      tileLayers.current = [enc]
    } else {
      // NOAA's Maritime Chart Service depth layer renders actual numeric soundings.
      const ChartLayer = L.GridLayer.extend({
        createTile: function (coords, done) {
          const tile = document.createElement('img')
          tile.alt = ''
          tile.setAttribute('role', 'presentation')
          const size = this.getTileSize()
          const mapRef = this._map
          const nw = mapRef.unproject(coords.scaleBy(size), coords.z)
          const se = mapRef.unproject(coords.add([1, 1]).scaleBy(size), coords.z)
          const nw3857 = mapRef.options.crs.project(nw)
          const se3857 = mapRef.options.crs.project(se)
          const params = new URLSearchParams({
            bbox: `${nw3857.x},${se3857.y},${se3857.x},${nw3857.y}`,
            bboxSR: '3857', imageSR: '3857', size: `${size.x},${size.y}`,
            format: 'png32', transparent: 'false', layers: 'show:2', f: 'image',
            display_params: noaaExportDisplayParams(noaaDepthUnits),
            cacheBust: Date.now()
          })
          tile.onload = () => done(null, tile)
          tile.onerror = () => done(new Error('NOAA sounding export failed'), tile)
          tile.src = `https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/MapServer/export?${params}`
          return tile
        }
      })
      const chartLayer = new ChartLayer({ tileSize: 256, maxZoom: 19, attribution: 'NOAA Office of Coast Survey' }).addTo(map.current)
      chartLayer.on('tileerror', () => setNotice('NOAA depth soundings are temporarily unavailable'))
      tileLayers.current = [chartLayer]
    }
    const chartGridLayer = tileLayers.current[0]
    if (chartGridLayer && typeof chartGridLayer.redraw === 'function' && !satellite) {
      chartGridLayer.redraw()
    }
    setNotice(satellite ? 'Satellite imagery enabled' : mapStyle === 'enc' ? `NOAA ENC chart (${noaaDepthUnits === 'meters' ? 'meters' : 'feet'}) enabled — official navigational chart symbology` : `NOAA chart (${noaaDepthUnits === 'meters' ? 'meters' : 'feet'}) enabled — zoom in for numeric depth soundings`)

    // Ensure Leaflet updates for the actual container size and requests all tiles.
    // This addresses partial/half-page tile rendering when the map container dimensions change or transforms are applied.
    if (map.current) {
      // Slight delay lets DOM layout settle after react renders
      setTimeout(() => {
        try {
          map.current.invalidateSize()
          tileLayers.current.forEach((layer) => { if (layer && typeof layer.redraw === 'function') layer.redraw() })
        } catch (e) { /* ignore */ }
      }, 120)
    }
  }, [mapStyle, noaaDepthUnits, encRefresh])

  const selectedTrip = useMemo(() => activeDestination ? trips.find((trip) => trip.destinationId === activeDestination) : null, [trips, activeDestination])

  useEffect(() => {
    if (!map.current || !window.L) return
    const L = window.L
    layers.current.forEach((layer) => layer.remove())
    layers.current = []
    markers.forEach((marker) => {
      const emoji = marker.type === 'Lobster pot' ? '⚓' : marker.type === 'Hazard' ? '⚠️' : marker.type === 'Anchor point' ? '⚓' : '🐟'
      const icon = L.divIcon({ className: 'map-pin', html: `<span>${emoji}</span>` })
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

  // Update boat SVG icon whenever heading changes
  useEffect(() => {
    if (!userMarker.current || !window.L) return
    userMarker.current.setIcon(window.L.divIcon({ className: 'boat-pin', html: boatIcon(heading), iconSize: [28, 28], iconAnchor: [14, 14] }))
  }, [heading])

  function updatePosition(coords) {
    const next = [coords.latitude, coords.longitude]
    setPosition(next)
    if (Number.isFinite(coords.accuracy)) setAccuracy(coords.accuracy)

    // Always compute course heading from GPS so the boat arrow rotates in ALL modes (north-up + follow)
    if (trackingRef.current) {
      const previous = lastTravelPointRef.current
      let course = Number.isFinite(coords.heading) && coords.heading >= 0 && (coords.speed == null || coords.speed > 0.5) ? coords.heading : null
      if (course == null && previous) {
        const lat1 = previous.latitude * Math.PI / 180; const lat2 = coords.latitude * Math.PI / 180
        const dLon = (coords.longitude - previous.longitude) * Math.PI / 180
        const y = Math.sin(dLon) * Math.cos(lat2); const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
        const moved = Math.hypot(coords.latitude - previous.latitude, (coords.longitude - previous.longitude) * Math.cos(lat2)) * 111320
        if (moved >= 3) course = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
      }
      if (course != null) {
        const delta = ((course - headingRef.current + 540) % 360) - 180
        if (!hasHeadingRef.current) { headingRef.current = course; hasHeadingRef.current = true }
        else if (Math.abs(delta) > 1) headingRef.current = (headingRef.current + delta * 0.12 + 360) % 360
        setHeading(headingRef.current)
      }
      lastTravelPointRef.current = { latitude: coords.latitude, longitude: coords.longitude }
    }

    if (map.current && window.L) {
      if (!userMarker.current) {
        userMarker.current = window.L.marker(next, {
          icon: window.L.divIcon({ className: 'boat-pin', html: boatIcon(headingRef.current), iconSize: [28, 28], iconAnchor: [14, 14] })
        }).addTo(map.current)
      } else {
        userMarker.current.setLatLng(next)
      }
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
    if (!navigator.geolocation) {
      setNotice('GPS is not supported by this browser')
      return
    }

    setAcquiringGPS(true)
    setNotice('Obtaining GPS lock before starting trip…')

    navigator.geolocation.getCurrentPosition(
      (p) => {
        setAcquiringGPS(false)
        const next = [p.coords.latitude, p.coords.longitude]

        setPosition(next)
        if (Number.isFinite(p.coords.accuracy)) setAccuracy(p.coords.accuracy)

        if (map.current && window.L) {
          if (!userMarker.current) {
            userMarker.current = window.L.marker(next, {
              icon: window.L.divIcon({ className: 'boat-pin', html: boatIcon(headingRef.current), iconSize: [28, 28], iconAnchor: [14, 14] })
            }).addTo(map.current)
          } else {
            userMarker.current.setLatLng(next)
          }
          if (!accuracyCircle.current) {
            accuracyCircle.current = window.L.circle(next, { radius: p.coords.accuracy || 10, color: '#58e1c4', weight: 1, fillColor: '#58e1c4', fillOpacity: 0.12 }).addTo(map.current)
          } else {
            accuracyCircle.current.setLatLng(next).setRadius(p.coords.accuracy || 10)
          }
          map.current.flyTo(next, 15, { animate: true, duration: 1.5 })
        }

        lastTravelPointRef.current = { latitude: p.coords.latitude, longitude: p.coords.longitude }
        setTrips((old) => old.some((trip) => trip.destinationId === activeDestination) ? old : [...old, { id: uid(), destinationId: activeDestination, points: [next, next], createdAt: Date.now() }])

        trackingRef.current = true
        setTracking(true)
        setNotice('Recording your route — screen will stay awake')

        watch.current = navigator.geolocation.watchPosition(
          (watchP) => updatePosition(watchP.coords),
          () => setNotice('GPS unavailable — using last known position'),
          { enableHighAccuracy: true, maximumAge: 0, timeout: 3000 }
        )
      },
      (_err) => {
        setAcquiringGPS(false)
        setNotice('GPS signal required to start trip')
      },
      { enableHighAccuracy: true, timeout: 10000 }
    )
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

  function toggleMapStyle() { setMapStyle((style) => style === 'satellite' ? 'nautical' : style === 'nautical' ? 'enc' : 'satellite') }

  function selectDestination(id) {
    activeDestinationRef.current = id
    setActiveDestination(id)
    const destination = destinations.find((item) => item.id === id)
    if (destination) map.current?.flyTo(destination.coords, 15)
    setNotice(`Showing routes to ${destination?.name || 'destination'}`)
    setDestDropdownOpen(false)
  }

  // Full marker editing: open modal pre-filled with all current values
  function editMarker(id) {
    const marker = markers.find((item) => item.id === id)
    if (!marker) return
    setEditingMarker({ id: marker.id, name: marker.name, type: marker.type || 'Fish spot', depth: marker.depth || '', coords: [...marker.coords] })
  }

  function saveMarkerEdit() {
    if (!editingMarker) return
    if (!editingMarker.name.trim()) { setNotice('Give this location a name'); return }
    setMarkers((list) => list.map((item) => item.id === editingMarker.id
      ? { ...item, name: editingMarker.name.trim(), type: editingMarker.type, depth: editingMarker.depth || null, coords: editingMarker.coords }
      : item
    ))
    setEditingMarker(null)
    setNotice('Marker updated')
  }

  // Enter relocation mode: next map click sets the new coords inside editingMarker
  function startMarkerRelocation() {
    relocatingMarkerRef.current = true
    setRelocatingMarker(true)
    setNotice('Tap the map to set the new marker location')
  }

  function deleteMarker(id) {
    const marker = markers.find((item) => item.id === id)
    if (!marker || !window.confirm(`Delete "${marker.name}"?`)) return
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


  // Force fully remove any ENC/Chart grid layers and recreate them.
  function forceRecreateEncLayers() {
    try {
      if (!map.current || !window.L) return
      console.log('Forcing full ENC layer recreate — removing existing grid layers')
      // remove tracked tileLayers
      tileLayers.current.forEach((layer) => { try { layer.remove() } catch (e) {} })
      tileLayers.current = []
      // also remove any GridLayer instances directly on the map
      map.current.eachLayer((layer) => {
        try {
          if (window.L && layer instanceof window.L.GridLayer) {
            map.current.removeLayer(layer)
          }
        } catch (e) { }
      })
      // small delay then bump encRefresh to trigger effect that recreates layers
      setNotice('Refreshing ENC layers…')
      setTimeout(() => setEncRefresh((n) => n + 1), 80)
    } catch (e) { console.error('forceRecreateEncLayers error', e) }
  }

  const [fabPos, setFabPos] = useState(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [expandedCategory, setExpandedCategory] = useState('voyage')
  const fabDragRef = useRef({ isDragging: false, startX: 0, startY: 0, initialX: 0, initialY: 0, moved: false, suppressClick: false })

  function handleFabPointerDown(e) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = e.currentTarget.getBoundingClientRect()
    fabDragRef.current = {
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      initialX: rect.left,
      initialY: rect.top,
      moved: false,
      suppressClick: false
    }
  }

  function handleFabPointerMove(e) {
    if (!fabDragRef.current.isDragging) return
    const dx = e.clientX - fabDragRef.current.startX
    const dy = e.clientY - fabDragRef.current.startY
    if (Math.hypot(dx, dy) > 5) {
      fabDragRef.current.moved = true
      const maxRight = (window.innerWidth || document.documentElement.clientWidth) - 62
      const maxBottom = (window.innerHeight || document.documentElement.clientHeight) - 62
      const nextX = Math.max(10, Math.min(maxRight, fabDragRef.current.initialX + dx))
      const nextY = Math.max(10, Math.min(maxBottom, fabDragRef.current.initialY + dy))
      setFabPos({ x: nextX, y: nextY })
    }
  }

  function handleFabPointerUp(e) {
    if (!fabDragRef.current.isDragging) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
    // Let the button's click event handle activation. This is more reliable for
    // touch browsers than relying on pointerup to open the drawer.
    fabDragRef.current.suppressClick = fabDragRef.current.moved
    fabDragRef.current.isDragging = false
  }

  function handleFabClick() {
    if (fabDragRef.current.suppressClick) {
      fabDragRef.current.suppressClick = false
      return
    }
    setDrawerOpen((prev) => !prev)
  }

  const renderUtilityControls = (isDrawer = false) => {
    const category = (id, label, content) => isDrawer ? (
      <section className="drawer-category" key={id}>
        <button
          type="button"
          className="drawer-category-toggle"
          aria-expanded={expandedCategory === id}
          onClick={() => setExpandedCategory((current) => current === id ? null : id)}
        >
          <span>{label}</span>
          <span className="drawer-category-arrow">{expandedCategory === id ? '−' : '+'}</span>
        </button>
        {expandedCategory === id && <div className="drawer-category-content">{content}</div>}
      </section>
    ) : content

    return (
      <>
      {isDrawer ? (
        <div className="drawer-header">
          <div className="brand">
            <div className="brand-mark">⌁</div>
            <div><b>HELM</b><small>NAVIGATION UTILITIES</small></div>
          </div>
          <button type="button" className="drawer-close" aria-label="Close drawer" onClick={() => setDrawerOpen(false)}>×</button>
        </div>
      ) : (
        <div className="brand">
          <div className="brand-mark">⌁</div>
          <div><b>HELM</b><small>MARINE NAVIGATION</small></div>
        </div>
      )}

      <div className="status"><span className={tracking ? 'live-dot' : ''}></span>{notice}</div>

      {category('voyage', 'YOUR VOYAGE', <section>
        <p className="eyebrow">YOUR VOYAGE</p>
        <h1>{active ? active.name : 'No destination set'}</h1>
        <p className="subtle">{active ? `${selectedTrip?.points.length || 0} recorded waypoints` : 'Select a saved location to begin'}</p>
        <button
          className={tracking ? 'primary recording' : 'primary'}
          onClick={() => { toggleTracking(); if (isDrawer && tracking) setDrawerOpen(false); }}
          disabled={acquiringGPS}
        >
          {acquiringGPS ? '⌛  Obtaining GPS lock…' : tracking ? '■  End & save track' : '▶  Start trip tracking'}
        </button>
      </section>)}

      {category('chart', 'CHART & DISPLAY', <section className="section">
        <p className="eyebrow">CHART & DISPLAY</p>
        <div className="drawer-controls-row">
          <button
            type="button"
            className="drawer-chip"
            onClick={toggleMapStyle}
          >
            {mapStyle === 'satellite' ? '◈ Style: Satellite' : mapStyle === 'nautical' ? '⌘ Style: Depth Chart' : '▣ Style: NOAA ENC'}
          </button>
          <button
            type="button"
            className="drawer-chip"
            disabled={mapStyle === 'satellite'}
            onClick={() => {
              if (mapStyle === 'satellite') return
              const next = noaaDepthUnits === 'meters' ? 'feet' : 'meters'
              setNoaaDepthUnits(next)
              store('noaaDepthUnits', next)
              setNotice(`Depth units: ${next}`)
              forceRecreateEncLayers()
            }}
          >
            {noaaDepthUnits === 'meters' ? 'Units: Meters (m)' : 'Units: Feet (ft)'}
          </button>
        </div>
        <div className="drawer-controls-row" style={{ marginTop: '8px' }}>
          <button
            type="button"
            className={followHeading ? 'drawer-chip active' : 'drawer-chip'}
            onClick={toggleHeading}
          >
            {followHeading ? '✦ Compass: Follow course' : '✧ Compass: North-up'}
          </button>
        </div>
      </section>)}

      {category('destinations', 'DESTINATIONS', <section className="section" ref={destDropdownRef}>
        <p className="eyebrow">DESTINATIONS</p>
        <div className="custom-dropdown">
          <button
            type="button"
            className="dropdown-trigger"
            onClick={() => setDestDropdownOpen(!destDropdownOpen)}
          >
            <span>◆</span>
            <div className="trigger-text">
              {active ? active.name : 'Select Destination'}
              <small>{destinations.length} saved</small>
            </div>
            <span className="arrow">{destDropdownOpen ? '▲' : '▼'}</span>
          </button>
          {destDropdownOpen && (
            <div className="dropdown-menu">
              <div className="dropdown-items">
                {destinations.length ? (
                  destinations.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className={activeDestination === d.id ? 'dropdown-item active' : 'dropdown-item'}
                      onClick={() => { selectDestination(d.id); if (isDrawer) setDrawerOpen(false); }}
                    >
                      <span>◆</span>
                      <div>
                        {d.name}
                        <small>{trips.filter((t) => t.destinationId === d.id).length} {trips.filter((t) => t.destinationId === d.id).length === 1 ? 'trip' : 'trips'}</small>
                      </div>
                    </button>
                  ))
                ) : (
                  <p className="dropdown-empty-msg">No destinations saved</p>
                )}
              </div>
              <button
                type="button"
                className="dropdown-add-btn"
                onClick={() => { setMode('destination'); setDestDropdownOpen(false); if (isDrawer) setDrawerOpen(false); }}
              >
                ＋ Add destination
              </button>
            </div>
          )}
        </div>
      </section>)}

      {category('markers', 'SAVED MARKERS', <section className="section marker-section" ref={markerDropdownRef}>
        <p className="eyebrow">SAVED MARKERS</p>
        <div className="custom-dropdown">
          <button
            type="button"
            className="dropdown-trigger"
            onClick={() => setMarkerDropdownOpen(!markerDropdownOpen)}
          >
            <span>📍</span>
            <div className="trigger-text">
              Saved Markers
              <small>{markers.length} marked spots</small>
            </div>
            <span className="arrow">{markerDropdownOpen ? '▲' : '▼'}</span>
          </button>
          {markerDropdownOpen && (
            <div className="dropdown-menu">
              <div className="dropdown-items">
                {markers.length ? (
                  markers.map((marker) => {
                    const emoji = marker.type === 'Lobster pot' ? '⚓' : marker.type === 'Hazard' ? '⚠️' : marker.type === 'Anchor point' ? '⚓' : '🐟'
                    return (
                      <div className="dropdown-item-row" key={marker.id}>
                        <button
                          type="button"
                          className="marker-jump"
                          onClick={() => {
                            map.current?.flyTo(marker.coords, 16)
                            setMarkerDropdownOpen(false)
                            if (isDrawer) setDrawerOpen(false)
                          }}
                        >
                          <span>{emoji}</span>
                          <div>
                            {marker.name}
                            <small>{marker.depth ? `${marker.depth} ft · ` : ''}{marker.type}</small>
                          </div>
                        </button>
                        <div className="marker-actions">
                          <button
                            type="button"
                            className="marker-action"
                            onClick={(e) => {
                              e.stopPropagation()
                              editMarker(marker.id)
                              setMarkerDropdownOpen(false)
                              if (isDrawer) setDrawerOpen(false)
                            }}
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className="marker-action delete"
                            onClick={(e) => {
                              e.stopPropagation()
                              deleteMarker(marker.id)
                            }}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    )
                  })
                ) : (
                  <p className="dropdown-empty-msg">Your fish and lobster markers will appear here.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </section>)}

      {category('quick-actions', 'QUICK ACTIONS', <section className="section">
        <p className="eyebrow">QUICK ACTIONS</p>
        <div className="quick-actions">
          <button onClick={() => { setMode('marker'); if (isDrawer) setDrawerOpen(false); }}>🐟<span>Drop spot</span></button>
          <button onClick={() => { locate(); if (isDrawer) setDrawerOpen(false); }}>◎<span>My location</span></button>
          <button className={adjustingPosition ? 'adjusting' : ''} onClick={() => { togglePositionAdjustment(); if (isDrawer) setDrawerOpen(false); }}>⌖<span>Adjust spot</span></button>
        </div>
        <button className={showDepthChart ? 'depth-toggle active' : 'depth-toggle'} onClick={() => setShowDepthChart((visible) => !visible)}>▥ <span>{showDepthChart ? 'Hide depth chart reports' : 'Show depth chart reports'}</span></button>
      </section>)}

      {category('storage', 'ROUTE STORAGE', <section className="section storage-section">
        <p className="eyebrow">ROUTE STORAGE</p>
        <div className="storage-actions">
          <button onClick={exportZip}>⇩ Export ZIP</button>
          <button onClick={() => fileInputRef.current?.click()}>⇧ Import ZIP</button>
          <input ref={fileInputRef} type="file" accept=".zip,application/zip" onChange={importZip} hidden />
        </div>
      </section>)}

      <footer>
        <span>GPS {navigator.geolocation ? 'READY' : 'UNAVAILABLE'}{accuracy ? ` · ±${Math.round(accuracy)}m` : ''}</span>
        <span>{position[0].toFixed(4)}, {Math.abs(position[1]).toFixed(4)}°W</span>
      </footer>
      </>
    )
  }

  return <main className="app-shell">
    <aside className="sidebar">
      {renderUtilityControls(false)}
    </aside>
    <button
      type="button"
      className={`fab-circle${drawerOpen ? ' active' : ''}`}
      style={fabPos ? { left: `${fabPos.x}px`, top: `${fabPos.y}px`, right: 'auto', bottom: 'auto' } : undefined}
      onPointerDown={handleFabPointerDown}
      onPointerMove={handleFabPointerMove}
      onPointerUp={handleFabPointerUp}
      onClick={handleFabClick}
      aria-label="Open Navigation Utilities"
      title="Drag to reposition · Tap to open utilities menu"
    >
      <span className="fab-mark">⌁</span>
      <small>MENU</small>
      <span className={tracking ? 'fab-dot live' : 'fab-dot'}></span>
    </button>

    {drawerOpen && (
      <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)}>
        <aside className="utility-drawer" onClick={(e) => e.stopPropagation()}>
          {renderUtilityControls(true)}
        </aside>
      </div>
    )}

    <section className="map-area">
      {/* The rotating map div — zoom controls are NOT inside here so they don't rotate */}
      <div
        ref={mapNode}
        style={{ '--map-rotation': followHeading ? `${-heading}deg` : '0deg' }}
        className={`${mode || relocatingMarker ? 'map picking' : 'map'}${followHeading ? ' heading-active' : ''}`}
      ></div>

      <div className="map-top">
        <div>
            <span className="map-label">{mapStyle === 'satellite' ? 'SATELLITE' : mapStyle === 'enc' ? 'NOAA ENC' : 'DEPTH CHART'}</span>
            <p>{followHeading ? `HEADING ${Math.round(heading)}° · COMPASS FOLLOWING` : mapStyle === 'satellite' ? 'Live marine overview' : mapStyle === 'enc' ? 'Electronic Navigational Chart · official NOAA symbology' : 'NOAA ENC depth soundings · contours · seamarks'}</p>
        </div>
          <button className="map-style-button" onClick={toggleMapStyle}>
            {mapStyle === 'satellite' ? '◈ Depth chart' :
             mapStyle === 'nautical' ? '⌘ NOAA ENC' :
             '▣ Satellite view'}
          </button>
          <button
            type="button"
            className="map-style-button"
            disabled={mapStyle === 'satellite'}
            title={mapStyle === 'satellite' ? 'Switch to Depth chart or NOAA ENC to change sounding units' : undefined}
            aria-label={mapStyle === 'satellite' ? 'Switch to Depth chart or NOAA ENC to change sounding units' : `Depth units: ${noaaDepthUnits === 'meters' ? 'meters' : 'feet'}`}
            onClick={() => {
              if (mapStyle === 'satellite') return
              const next = noaaDepthUnits === 'meters' ? 'feet' : 'meters'
            console.log('Units button clicked, next units:', next, 'current mapStyle:', mapStyle)
            setNoaaDepthUnits(next)
            // force recreation of ENC/export layers in case the provider cached or did not re-export
            store('noaaDepthUnits', next)
            setNotice(`Depth units: ${next}`)
            // aggressively remove & recreate layers
            forceRecreateEncLayers()
            // Aggressive recreate requested; do not reload or switch map style — let layers be rebuilt in-place
            console.log('Requested ENC layer recreate')
            setNotice('Refreshing ENC layers…')
            }}
          >
            {noaaDepthUnits === 'meters' ? 'Units: m' : 'Units: ft'}
          </button>
        <button onClick={() => setMode('marker')}>＋ Add spot</button>
        <button className={followHeading ? 'heading-button active' : 'heading-button'} onClick={toggleHeading}>{followHeading ? '✦ North-up' : '✧ Follow heading'}</button>
      </div>

      <div className="map-legend">
        <span><i className="route-key"></i>Saved route{active ? ` to ${active.name}` : 's'}</span>
        <span><i className="boat-key">▲</i>Your vessel</span>
      </div>

      {/* Custom zoom controls anchored to map-area, outside the rotating map div */}
      <div className="custom-zoom-controls">
        <button id="zoom-in" aria-label="Zoom in" onClick={() => map.current?.zoomIn()}>+</button>
        <button id="zoom-out" aria-label="Zoom out" onClick={() => map.current?.zoomOut()}>−</button>
      </div>

      {/* Relocation banner — shown while the user is picking a new position for a marker */}
      {relocatingMarker && (
        <div className="relocate-banner">
          <span>📍 Tap the chart to place the marker</span>
          <button type="button" onClick={() => { relocatingMarkerRef.current = false; setRelocatingMarker(false) }}>Cancel</button>
        </div>
      )}

      {/* Sounding key shown when nautical chart is active */}
        {mapStyle === 'nautical' && (
        <div className="depth-legend-cmap">
          <p>CHART LEGEND</p>
          <div className="sounding-key-row"><span className="sk-num">14</span><span className="sk-label">Depth sounding ({noaaDepthUnits === 'meters' ? 'm' : 'ft'})</span></div>
          <div className="sounding-key-row"><span className="sk-line"></span><span className="sk-label">Depth contour</span></div>
          <div className="sounding-key-row"><span className="sk-mark">⬟</span><span className="sk-label">Seamark / buoy</span></div>
          <p className="sk-note">Numbers are charted depths; zoom in to see more.</p>
        </div>
        )}
        {mapStyle === 'enc' && (
          <div className="depth-legend-cmap">
            <p>NOAA Electronic Navigational Chart</p>
            <div className="sounding-key-row"><span className="sk-num">14</span><span className="sk-label">Charted sounding ({noaaDepthUnits === 'meters' ? 'm' : 'ft'})</span></div>
            <div className="sounding-key-row"><span className="sk-mark">⚓</span><span className="sk-label">Navigation aid / feature</span></div>
            <p className="sk-note">Official NOAA Electronic Navigational Chart layers. Zoom in for chart detail.</p>
          </div>
        )}

      {showDepthChart && <aside className="depth-panel"><div className="depth-header"><div><p className="eyebrow">REPORTED DEPTHS</p><strong>{depthPoints.length ? `${depthPoints.length} marked locations` : 'No depth reports yet'}</strong></div><button onClick={() => setShowDepthChart(false)}>×</button></div>{depthPoints.length ? <div className="depth-bars">{depthPoints.map((point) => <div className="depth-row" key={point.id}><span className="depth-name">{point.name}</span><div className="depth-track"><i style={{ width: `${Math.max(8, Number(point.depth) / maxDepth * 100)}%` }}></i></div><b>{point.depth} ft</b></div>)}</div> : <p className="depth-empty">Add a marker and enter its depth to build your chart.</p>}<small>Depths are user-reported at each saved marker.</small></aside>}
    </section>

    {/* New marker / destination modal */}
    {mode && <div className="modal-backdrop"><form className="modal" onSubmit={(e) => { e.preventDefault(); savePoint() }}><button type="button" className="close" onClick={() => setMode(null)}>×</button><p className="eyebrow">{mode === 'destination' ? 'NEW DESTINATION' : 'NEW MARKER'}</p><h2>{mode === 'destination' ? 'Where are you going?' : 'Mark this water'}</h2><p className="subtle">{draft.coords ? 'Location selected on the chart' : 'Uses your current location — or click the chart to choose one.'}</p><label>Name<input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={mode === 'destination' ? 'e.g. North Channel' : 'e.g. Productive reef'} /></label>{mode === 'marker' && <><label>Marker type<select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}><option>Fish spot</option><option>Lobster pot</option><option>Hazard</option><option>Anchor point</option></select></label><label>Depth (feet)<input type="number" min="0" value={depth} onChange={(e) => setDepth(e.target.value)} placeholder="Optional" /></label></>}<button className="primary" type="submit">Save {mode === 'destination' ? 'destination' : 'marker'}</button></form></div>}

    {/* Edit existing marker modal */}
    {editingMarker && !relocatingMarker && (
      <div className="modal-backdrop">
        <form className="modal" onSubmit={(e) => { e.preventDefault(); saveMarkerEdit() }}>
          <button type="button" className="close" onClick={() => setEditingMarker(null)}>×</button>
          <p className="eyebrow">EDIT MARKER</p>
          <h2>Edit this spot</h2>
          <p className="subtle">
            {editingMarker.coords
              ? `${Number(editingMarker.coords[0]).toFixed(5)}°, ${Number(editingMarker.coords[1]).toFixed(5)}°`
              : 'Location unchanged'}
          </p>
          <label>Name
            <input autoFocus value={editingMarker.name} onChange={(e) => setEditingMarker({ ...editingMarker, name: e.target.value })} placeholder="Marker name" />
          </label>
          <label>Marker type
            <select value={editingMarker.type} onChange={(e) => setEditingMarker({ ...editingMarker, type: e.target.value })}>
              <option>Fish spot</option>
              <option>Lobster pot</option>
              <option>Hazard</option>
              <option>Anchor point</option>
            </select>
          </label>
          <label>Depth (feet)
            <input type="number" min="0" value={editingMarker.depth} onChange={(e) => setEditingMarker({ ...editingMarker, depth: e.target.value })} placeholder="Optional" />
          </label>
          <button type="button" className="relocate-button" onClick={startMarkerRelocation}>
            📍 Pick new location on chart
          </button>
          <button className="primary" type="submit">Save changes</button>
        </form>
      </div>
    )}
  </main>
}

function App() {
  return <Navigator />
}

export default App
