import { useState, useEffect, useCallback } from 'react'
import {
  Box,
  Typography,
  Button,
  Alert,
  Fade,
  Stack,
} from '@mui/material'
import QrCodeScannerRounded from '@mui/icons-material/QrCodeScannerRounded'
import WifiOffRounded from '@mui/icons-material/WifiOffRounded'
import {
  Scanner,
  type IDetectedBarcode,
  type IScannerError,
  type ScannerErrorKind,
} from '@yudiel/react-qr-scanner'
import { useScanTicket, isOffline } from '../features/scanner/hooks'
import { ScanResult } from '../features/scanner/components/ScanResult'

// Map the scanner library's failure kinds to clear, actionable copy.
const cameraErrorCopy = (kind: ScannerErrorKind): string => {
  switch (kind) {
    case 'permission-denied':
    case 'security':
      return 'Camera access denied. Enable it in your browser settings to scan tickets.'
    case 'no-camera':
      return 'No camera was found on this device.'
    case 'in-use':
      return 'The camera is being used by another app. Close it and try again.'
    case 'insecure-context':
      return 'The camera requires a secure (HTTPS) connection.'
    case 'unsupported':
      return "This browser doesn't support camera scanning."
    default:
      return "Couldn't start the camera. Please try again."
  }
}

export default function ScannerPage() {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const scan = useScanTicket()

  // US-AG19 — react to connectivity changes so the camera mounts/unmounts live.
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  // The camera freezes (shows the last frame) whenever we're not idle: a request is
  // in-flight, or a result/error is on screen awaiting the agent's "Scan next".
  const settled = scan.isSuccess || scan.isError
  const paused = scan.isPending || settled

  // One physical QR → exactly one request: ignore detections while not idle (re-arm guard).
  const handleScan = useCallback(
    (codes: IDetectedBarcode[]) => {
      if (paused) return
      const token = codes[0]?.rawValue
      if (token) scan.mutate(token)
    },
    [paused, scan],
  )

  const scanNext = () => {
    scan.reset()
    setCameraError(null)
  }

  const networkError = scan.isError && isOffline(scan.error)

  const header = (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 3 }}>
      <QrCodeScannerRounded color="primary" />
      <Typography variant="h4" component="h1">
        Scan ticket
      </Typography>
    </Stack>
  )

  // Offline: don't mount the camera at all (US-AG19).
  if (!online) {
    return (
      <Fade in timeout={400}>
        <Box sx={{ maxWidth: 480, mx: 'auto' }}>
          {header}
          <Alert severity="warning" icon={<WifiOffRounded />}>
            Validation requires an internet connection. Reconnect to scan tickets — the
            scanner verifies every code against the server in real time.
          </Alert>
        </Box>
      </Fade>
    )
  }

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 480, mx: 'auto' }}>
        {header}

        {cameraError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {cameraError}
          </Alert>
        )}
        {networkError && (
          <Alert severity="warning" icon={<WifiOffRounded />} sx={{ mb: 2 }}>
            Validation requires an internet connection. Reconnect and scan again.
          </Alert>
        )}
        {scan.isError && !networkError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            Couldn't validate the ticket. Please try again.
          </Alert>
        )}

        <Box
          sx={{
            position: 'relative',
            borderRadius: 3,
            overflow: 'hidden',
            border: '1px solid',
            borderColor: 'divider',
            bgcolor: 'common.black',
            aspectRatio: '1 / 1',
          }}
        >
          <Scanner
            onScan={handleScan}
            onError={(e: IScannerError) => setCameraError(cameraErrorCopy(e.kind))}
            paused={paused}
            constraints={{ facingMode: 'environment' }}
            styles={{ container: { width: '100%', height: '100%' } }}
          />
        </Box>

        {scan.data && (
          <Box sx={{ mt: 2 }}>
            <ScanResult result={scan.data} />
          </Box>
        )}

        {settled && (
          <Button
            fullWidth
            variant="contained"
            size="large"
            disableElevation
            onClick={scanNext}
            sx={{ mt: 2 }}
          >
            Scan next
          </Button>
        )}

        {!settled && !scan.isPending && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 2, textAlign: 'center' }}
          >
            Point the camera at the client's QR code.
          </Typography>
        )}
      </Box>
    </Fade>
  )
}
