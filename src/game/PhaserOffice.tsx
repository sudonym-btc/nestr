import { useEffect, useRef } from 'react'
import Phaser from 'phaser'
import { OfficeScene, type MoveHandler, type OfficeSceneSnapshot } from './OfficeScene'

interface PhaserOfficeProps {
  snapshot: OfficeSceneSnapshot
  onMove: MoveHandler
}

export function PhaserOffice({ snapshot, onMove }: PhaserOfficeProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<OfficeScene | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const scene = new OfficeScene()
    sceneRef.current = scene

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host,
      backgroundColor: '#f7ecd9',
      scene,
      width: host.clientWidth,
      height: host.clientHeight,
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      render: {
        antialias: false,
        pixelArt: true,
      },
    })

    return () => {
      game.destroy(true)
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    sceneRef.current?.setMoveHandler(onMove)
  }, [onMove])

  useEffect(() => {
    sceneRef.current?.applySnapshot(snapshot)
  }, [snapshot])

  return <div ref={hostRef} className="office-canvas" data-testid="office-canvas" />
}
