import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Alerts from './pages/Alerts'
import Finder from './pages/Finder'
import Product from './pages/Product'
import Seed from './pages/Seed'
import Settings from './pages/Settings'
import Watchlist from './pages/Watchlist'

export default function App() { return <Routes><Route element={<Layout />}><Route index element={<Watchlist />} /><Route path="p/:asin" element={<Product />} /><Route path="alerts" element={<Alerts />} /><Route path="finder" element={<Finder />} /><Route path="seed" element={<Seed />} /><Route path="settings" element={<Settings />} /><Route path="*" element={<Navigate to="/" replace />} /></Route></Routes> }
