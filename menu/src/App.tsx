import React from 'react';
import './App.css';
import { useMenuContext } from "./provider/MenuProvider";
import { Fade } from "@material-ui/core";
import MenuRoot from "./components/MenuRoot";
import { SnackbarProvider } from "./provider/SnackbarProvider";

const App: React.FC = () => {
  const { visibility } = useMenuContext()

  return (
    <SnackbarProvider>
      <div className='App'>
        <Fade in={visibility}>
          <MenuRoot />
        </Fade>
      </div>
    </SnackbarProvider>
  )
}

export default App