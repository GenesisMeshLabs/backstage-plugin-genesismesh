export interface Config {
  genesismesh: {
    /** Absolute backend-only path to a private local authority fixture. @visibility secret */
    connectionFile: string;
    /** Private state directory owned by one backend process. @visibility backend */
    stateDirectory: string;
    localDemo: {
      /** Explicit acknowledgement that the installed adapter is a simulation. */
      enabled: boolean;
      /** Enable only for the isolated service-authenticated local test harness. */
      allowServiceInitiators?: boolean;
    };
  };
}
